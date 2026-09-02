import { readFileSync } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { satisfies, valid, validRange } from 'semver';
import { createPluginContext } from '@forge/kernel-context';
import {
  FORGE_API_VERSION,
  ForgeError,
  type ForgeApiVersion,
  type ForgeContext,
  type ForgePlugin,
  type PluginManifest,
  type PluginName,
  pluginName,
} from '@forge/kernel-contracts';

const MANIFEST_FILENAME = 'forge-plugin.json';
const SCHEMA_URL = new URL('../../../../schemas/plugin-v1.schema.json', import.meta.url);

export type PluginLifecycleState =
  | 'discovered'
  | 'validated'
  | 'dependency-sorted'
  | 'loading'
  | 'active'
  | 'stopping'
  | 'unloading'
  | 'unloaded'
  | 'disabled'
  | 'failed';

export interface DiscoveredPlugin {
  readonly manifest: PluginManifest;
  readonly directory: string;
  readonly manifestPath: string;
  readonly entrypointPath: string;
}

export interface PlannedPlugin {
  readonly plugin: DiscoveredPlugin;
  readonly dependencies: readonly PluginName[];
}

export interface PluginPlan {
  readonly plugins: readonly PlannedPlugin[];
}

export interface PluginTransition {
  readonly name: PluginName;
  readonly state: PluginLifecycleState;
}

export interface PluginGraphOptions {
  readonly externalServices?: Readonly<Record<string, string>>;
  readonly multiProviderServices?: readonly string[];
}

export interface PluginLoaderOptions extends PluginGraphOptions {
  readonly supportedApiVersion?: ForgeApiVersion;
  readonly importer?: (entrypoint: URL, plugin: DiscoveredPlugin) => Promise<unknown>;
  readonly onTransition?: (transition: PluginTransition) => void;
}

interface ActivePlugin {
  readonly plugin: DiscoveredPlugin;
  readonly context: ForgeContext;
  readonly dependencies: readonly PluginName[];
}

interface PluginModule {
  readonly plugin: ForgePlugin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function containsPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('${') || value.includes('{{');
  if (Array.isArray(value)) return value.some(containsPlaceholder);
  if (isRecord(value)) {
    return Object.entries(value).some(
      ([key, child]) => containsPlaceholder(key) || containsPlaceholder(child),
    );
  }
  return false;
}

function createManifestValidator(): ValidateFunction {
  const schema = JSON.parse(readFileSync(SCHEMA_URL, 'utf8')) as object;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addFormat('uri-reference', {
    type: 'string',
    validate(value: string): boolean {
      try {
        new URL(value, 'https://forge.dev/');
        return true;
      } catch {
        return false;
      }
    },
  });
  return ajv.compile(schema);
}

const validateManifestSchema = createManifestValidator();

function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ');
}

function validateRanges(manifest: PluginManifest, source: string): void {
  const groups = [manifest.requires ?? {}, manifest.optional ?? {}];
  for (const dependencies of groups) {
    for (const [service, range] of Object.entries(dependencies)) {
      if (!validRange(range)) {
        throw new ForgeError(
          'INVALID_MANIFEST',
          `Plugin ${manifest.name} has an invalid range for ${service}`,
          { source, service, range },
        );
      }
    }
  }

  const overlap = Object.keys(manifest.requires ?? {}).filter((service) =>
    Object.hasOwn(manifest.optional ?? {}, service),
  );
  if (overlap.length > 0) {
    throw new ForgeError(
      'INVALID_MANIFEST',
      `Plugin ${manifest.name} declares services as both required and optional`,
      { source, services: overlap.sort() },
    );
  }
}

export function validatePluginManifest(
  value: unknown,
  source = '<memory>',
  supportedApiVersion: ForgeApiVersion = FORGE_API_VERSION,
): PluginManifest {
  if (
    isRecord(value) &&
    typeof value.apiVersion === 'string' &&
    value.apiVersion !== supportedApiVersion
  ) {
    throw new ForgeError(
      'INCOMPATIBLE_API',
      `Plugin API ${value.apiVersion} is incompatible with ${supportedApiVersion}`,
      { source, received: value.apiVersion, supported: supportedApiVersion },
    );
  }

  if (!validateManifestSchema(value)) {
    throw new ForgeError(
      'INVALID_MANIFEST',
      `Invalid plugin manifest: ${formatSchemaErrors(validateManifestSchema.errors)}`,
      {
        source,
      },
    );
  }

  const manifest = value as PluginManifest;
  if (!valid(manifest.version)) {
    throw new ForgeError('INVALID_MANIFEST', `Plugin ${manifest.name} has an invalid version`, {
      source,
      version: manifest.version,
    });
  }
  pluginName(manifest.name);
  validateRanges(manifest, source);
  if (containsPlaceholder(manifest)) {
    throw new ForgeError('INVALID_MANIFEST', `Plugin ${manifest.name} contains a placeholder`, {
      source,
    });
  }
  return deepFreeze(manifest);
}

function normalizedPackageName(directory: string): string {
  return normalizedName(basename(directory));
}

function normalizedName(value: string): string {
  const unscoped = value.includes('/') ? (value.split('/').at(-1) ?? value) : value;
  return unscoped
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function validatePackageName(directory: string, manifest: PluginManifest): Promise<void> {
  const packagePath = join(directory, 'package.json');
  if (!(await isFile(packagePath))) return;
  let packageValue: unknown;
  try {
    packageValue = JSON.parse(await readFile(packagePath, 'utf8')) as unknown;
  } catch (error) {
    throw new ForgeError(
      'INVALID_MANIFEST',
      `Cannot parse ${packagePath}`,
      { packagePath },
      {
        cause: error,
      },
    );
  }
  if (!isRecord(packageValue) || typeof packageValue.name !== 'string') {
    throw new ForgeError('INVALID_MANIFEST', `Plugin package ${packagePath} has no name`);
  }
  if (normalizedName(packageValue.name) !== manifest.name) {
    throw new ForgeError(
      'INVALID_MANIFEST',
      `Package name ${packageValue.name} does not match manifest name ${manifest.name}`,
      { packagePath, packageName: packageValue.name, manifestName: manifest.name },
    );
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function candidateDirectories(searchRoot: string): Promise<string[]> {
  const absolute = resolve(searchRoot);
  if (basename(absolute) === MANIFEST_FILENAME && (await isFile(absolute))) {
    return [dirname(absolute)];
  }
  if (!(await stat(absolute)).isDirectory()) {
    throw new ForgeError('INVALID_MANIFEST', `Plugin search root is not a directory: ${absolute}`);
  }
  if (await isFile(join(absolute, MANIFEST_FILENAME))) return [absolute];

  const candidates: string[] = [];
  const entries = (await readdir(absolute, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const child = join(absolute, entry.name);
    if (await isFile(join(child, MANIFEST_FILENAME))) candidates.push(child);
    if (!entry.name.startsWith('@')) continue;
    const scopedEntries = (await readdir(child, { withFileTypes: true }))
      .filter((scoped) => scoped.isDirectory() && !scoped.name.startsWith('.'))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const scoped of scopedEntries) {
      const packageDirectory = join(child, scoped.name);
      if (await isFile(join(packageDirectory, MANIFEST_FILENAME))) {
        candidates.push(packageDirectory);
      }
    }
  }
  return candidates;
}

async function validateEntrypoint(directory: string, entrypoint: string): Promise<string> {
  const candidate = resolve(directory, entrypoint);
  const lexicalRelative = relative(directory, candidate);
  if (lexicalRelative.startsWith('..') || isAbsolute(lexicalRelative)) {
    throw new ForgeError('INVALID_MANIFEST', 'Plugin entrypoint escapes its package directory', {
      directory,
      entrypoint,
    });
  }
  if (!(await isFile(candidate))) {
    throw new ForgeError('INVALID_MANIFEST', 'Plugin entrypoint does not exist', {
      directory,
      entrypoint,
    });
  }

  const [realDirectory, realEntrypoint] = await Promise.all([
    realpath(directory),
    realpath(candidate),
  ]);
  const resolvedRelative = relative(realDirectory, realEntrypoint);
  if (resolvedRelative.startsWith('..') || isAbsolute(resolvedRelative)) {
    throw new ForgeError(
      'INVALID_MANIFEST',
      'Plugin entrypoint symlink escapes its package directory',
      {
        directory,
        entrypoint,
      },
    );
  }
  return realEntrypoint;
}

export async function discoverPlugins(
  searchRoots: readonly string[],
  supportedApiVersion: ForgeApiVersion = FORGE_API_VERSION,
): Promise<readonly DiscoveredPlugin[]> {
  const directories = new Set<string>();
  for (const root of searchRoots) {
    for (const candidate of await candidateDirectories(root)) {
      directories.add(await realpath(candidate));
    }
  }

  const discovered: DiscoveredPlugin[] = [];
  for (const directory of [...directories].sort()) {
    const manifestPath = join(directory, MANIFEST_FILENAME);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
    } catch (error) {
      throw new ForgeError(
        'INVALID_MANIFEST',
        `Cannot parse ${manifestPath}`,
        { manifestPath },
        {
          cause: error,
        },
      );
    }
    const manifest = validatePluginManifest(raw, manifestPath, supportedApiVersion);
    if (normalizedPackageName(directory) !== manifest.name) {
      throw new ForgeError(
        'INVALID_MANIFEST',
        `Plugin directory ${basename(directory)} does not match manifest name ${manifest.name}`,
        { directory, manifestName: manifest.name },
      );
    }
    await validatePackageName(directory, manifest);
    const entrypointPath = await validateEntrypoint(directory, manifest.entrypoint);
    discovered.push(Object.freeze({ manifest, directory, manifestPath, entrypointPath }));
  }
  return Object.freeze(discovered);
}

function dependencyEntries(manifest: PluginManifest): readonly [string, string, boolean][] {
  const entries = [
    ...Object.entries(manifest.requires ?? {}).map(
      ([service, range]) => [service, range, true] as [string, string, boolean],
    ),
    ...Object.entries(manifest.optional ?? {}).map(
      ([service, range]) => [service, range, false] as [string, string, boolean],
    ),
  ];
  entries.sort(([left], [right]) => left.localeCompare(right));
  return Object.freeze(entries);
}

export function resolvePluginGraph(
  plugins: readonly DiscoveredPlugin[],
  options: PluginGraphOptions = {},
): PluginPlan {
  const byName = new Map<string, DiscoveredPlugin>();
  const providers = new Map<string, DiscoveredPlugin[]>();
  const multi = new Set(options.multiProviderServices ?? []);

  for (const [service, version] of Object.entries(options.externalServices ?? {})) {
    if (!valid(version)) {
      throw new ForgeError(
        'INVALID_MANIFEST',
        `External service ${service} has an invalid version`,
        {
          service,
          version,
        },
      );
    }
  }

  for (const plugin of plugins) {
    const name = plugin.manifest.name;
    if (byName.has(name)) {
      throw new ForgeError('INVALID_MANIFEST', `Duplicate plugin name ${name}`, { name });
    }
    byName.set(name, plugin);
    for (const service of plugin.manifest.provides ?? []) {
      const entries = providers.get(service) ?? [];
      entries.push(plugin);
      providers.set(service, entries);
    }
  }

  for (const [service, entries] of providers) {
    const external = options.externalServices?.[service];
    if (!multi.has(service) && entries.length + (external !== undefined ? 1 : 0) > 1) {
      throw new ForgeError(
        'SERVICE_CONFLICT',
        `Exclusive service ${service} has multiple providers`,
        {
          service,
          providers: entries.map((entry) => entry.manifest.name),
          external: external !== undefined,
        },
      );
    }
  }

  const dependencies = new Map<string, Set<string>>();
  for (const plugin of plugins) {
    const pluginDependencies = new Set<string>();
    for (const [service, range, required] of dependencyEntries(plugin.manifest)) {
      const serviceProviders = providers.get(service) ?? [];
      const externalVersion = options.externalServices?.[service];
      if (serviceProviders.length === 0 && externalVersion === undefined) {
        if (required) {
          throw new ForgeError(
            'MISSING_SERVICE',
            `Plugin ${plugin.manifest.name} requires ${service}`,
            {
              plugin: plugin.manifest.name,
              service,
              range,
            },
          );
        }
        continue;
      }

      if (externalVersion !== undefined && !satisfies(externalVersion, range)) {
        throw new ForgeError(
          'INCOMPATIBLE_SERVICE',
          `External service ${service}@${externalVersion} does not satisfy ${range}`,
          { plugin: plugin.manifest.name, service, range, version: externalVersion },
        );
      }
      for (const provider of serviceProviders) {
        if (!satisfies(provider.manifest.version, range)) {
          throw new ForgeError(
            'INCOMPATIBLE_SERVICE',
            `Service ${service} from ${provider.manifest.name}@${provider.manifest.version} does not satisfy ${range}`,
            {
              plugin: plugin.manifest.name,
              provider: provider.manifest.name,
              service,
              range,
              version: provider.manifest.version,
            },
          );
        }
        pluginDependencies.add(provider.manifest.name);
      }
    }
    dependencies.set(plugin.manifest.name, pluginDependencies);
  }

  const remaining = new Map(
    [...dependencies].map(([name, values]) => [name, new Set(values)] as const),
  );
  const ordered: PlannedPlugin[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter(([, values]) => values.size === 0)
      .map(([name]) => name)
      .sort();
    if (ready.length === 0) {
      throw new ForgeError('DEPENDENCY_CYCLE', 'Plugin dependency graph contains a cycle', {
        plugins: [...remaining.keys()].sort(),
      });
    }
    for (const name of ready) {
      const plugin = byName.get(name);
      if (!plugin) {
        throw new ForgeError('INVARIANT_VIOLATION', `Planned plugin ${name} is missing`);
      }
      ordered.push(
        Object.freeze({
          plugin,
          dependencies: Object.freeze(
            [...(dependencies.get(name) ?? [])].sort().map((value) => pluginName(value)),
          ),
        }),
      );
      remaining.delete(name);
      for (const values of remaining.values()) values.delete(name);
    }
  }

  return Object.freeze({ plugins: Object.freeze(ordered) });
}

function manifestComparable(manifest: PluginManifest): object {
  return {
    apiVersion: manifest.apiVersion,
    name: manifest.name,
    version: manifest.version,
    runtime: manifest.runtime,
    entrypoint: manifest.entrypoint,
    requires: manifest.requires ?? {},
    optional: manifest.optional ?? {},
    provides: manifest.provides ?? [],
    contributes: manifest.contributes ?? {},
    permissions: manifest.permissions ?? {},
    extensions: manifest.extensions ?? {},
  };
}

function parsePluginModule(value: unknown, discovered: DiscoveredPlugin): PluginModule {
  if (!isRecord(value) || !isRecord(value.plugin) || typeof value.plugin.setup !== 'function') {
    throw new ForgeError(
      'PLUGIN_LOAD_FAILED',
      `Plugin ${discovered.manifest.name} has no plugin export`,
    );
  }
  const runtimeManifest = validatePluginManifest(
    value.plugin.manifest,
    `${discovered.entrypointPath}#plugin.manifest`,
  );
  if (
    !isDeepStrictEqual(manifestComparable(runtimeManifest), manifestComparable(discovered.manifest))
  ) {
    throw new ForgeError(
      'PLUGIN_LOAD_FAILED',
      `Plugin ${discovered.manifest.name} runtime manifest does not match forge-plugin.json`,
    );
  }
  return value as unknown as PluginModule;
}

async function defaultImporter(entrypoint: URL): Promise<unknown> {
  return import(entrypoint.href);
}

export class ForgePluginLoader {
  readonly #root: ForgeContext;
  readonly #options: PluginLoaderOptions;
  readonly #active = new Map<string, ActivePlugin>();
  readonly #activeOrder: string[] = [];
  readonly #disabled = new Set<string>();

  constructor(root: ForgeContext, options: PluginLoaderOptions = {}) {
    this.#root = root;
    this.#options = options;
  }

  get activePlugins(): readonly PluginName[] {
    return Object.freeze(this.#activeOrder.map((name) => pluginName(name)));
  }

  async discover(searchRoots: readonly string[]): Promise<readonly DiscoveredPlugin[]> {
    const plugins = await discoverPlugins(
      searchRoots,
      this.#options.supportedApiVersion ?? FORGE_API_VERSION,
    );
    for (const plugin of plugins) {
      this.#transition(plugin.manifest.name, 'discovered');
      this.#transition(plugin.manifest.name, 'validated');
    }
    return plugins;
  }

  resolve(plugins: readonly DiscoveredPlugin[]): PluginPlan {
    const enabled = plugins.filter((plugin) => !this.#disabled.has(plugin.manifest.name));
    const plan = resolvePluginGraph(enabled, this.#options);
    for (const node of plan.plugins) {
      this.#transition(node.plugin.manifest.name, 'dependency-sorted');
    }
    return plan;
  }

  async load(searchRoots: readonly string[]): Promise<PluginPlan> {
    const plan = this.resolve(await this.discover(searchRoots));
    await this.activate(plan);
    return plan;
  }

  async activate(plan: PluginPlan): Promise<void> {
    if (this.#active.size > 0) {
      throw new ForgeError('INVARIANT_VIOLATION', 'Unload active plugins before activating a plan');
    }
    for (const node of plan.plugins) {
      if (this.#disabled.has(node.plugin.manifest.name)) {
        throw new ForgeError(
          'PLUGIN_LOAD_FAILED',
          `Plugin ${node.plugin.manifest.name} is disabled`,
        );
      }
      if (node.plugin.manifest.runtime !== 'trusted') {
        throw new ForgeError(
          'PLUGIN_LOAD_FAILED',
          `Plugin ${node.plugin.manifest.name} requires the process runtime, which is not available yet`,
        );
      }
    }

    const activatedThisRun: string[] = [];
    let currentContext: ForgeContext | undefined;
    let currentPlugin: DiscoveredPlugin | undefined;
    try {
      for (const node of plan.plugins) {
        currentPlugin = node.plugin;
        this.#transition(currentPlugin.manifest.name, 'loading');
        currentContext = createPluginContext(this.#root, {
          name: `plugin:${currentPlugin.manifest.name}`,
          parentPlugin: currentPlugin.manifest.name,
        });
        const importer = this.#options.importer ?? defaultImporter;
        const module = parsePluginModule(
          await importer(pathToFileURL(currentPlugin.entrypointPath), currentPlugin),
          currentPlugin,
        );
        await module.plugin.setup(currentContext);
        this.#verifyProvidedServices(currentPlugin, currentContext);

        this.#active.set(currentPlugin.manifest.name, {
          plugin: currentPlugin,
          context: currentContext,
          dependencies: node.dependencies,
        });
        this.#activeOrder.push(currentPlugin.manifest.name);
        activatedThisRun.push(currentPlugin.manifest.name);
        this.#transition(currentPlugin.manifest.name, 'active');
        currentContext = undefined;
        currentPlugin = undefined;
      }
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (currentPlugin) this.#transition(currentPlugin.manifest.name, 'failed');
      if (currentContext) {
        try {
          await currentContext.dispose();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      for (const name of activatedThisRun.reverse()) {
        try {
          await this.#disposeActive(name);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      throw new ForgeError(
        'PLUGIN_LOAD_FAILED',
        `Plugin activation failed${currentPlugin ? ` for ${currentPlugin.manifest.name}` : ''}`,
        { cleanupErrorCount: cleanupErrors.length },
        { cause: cleanupErrors.length > 0 ? new AggregateError([error, ...cleanupErrors]) : error },
      );
    }
  }

  async disable(name: string): Promise<void> {
    const normalized = pluginName(name);
    this.#disabled.add(normalized);
    if (this.#active.has(normalized)) await this.unload(normalized);
    this.#transition(normalized, 'disabled');
  }

  enable(name: string): void {
    this.#disabled.delete(pluginName(name));
  }

  async unload(name: string): Promise<void> {
    const normalized = pluginName(name);
    if (!this.#active.has(normalized)) {
      throw new ForgeError('PLUGIN_NOT_FOUND', `Plugin ${normalized} is not active`, { name });
    }
    const targets = new Set<string>([normalized]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [candidate, active] of this.#active) {
        if (
          !targets.has(candidate) &&
          active.dependencies.some((dependency) => targets.has(dependency))
        ) {
          targets.add(candidate);
          changed = true;
        }
      }
    }

    const errors: unknown[] = [];
    for (const candidate of [...this.#activeOrder].reverse()) {
      if (!targets.has(candidate)) continue;
      try {
        await this.#disposeActive(candidate);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new ForgeError(
        'PLUGIN_DISPOSE_FAILED',
        `One or more plugins failed to unload with ${normalized}`,
        { plugin: normalized, errorCount: errors.length },
        { cause: new AggregateError(errors) },
      );
    }
  }

  async unloadAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const name of [...this.#activeOrder].reverse()) {
      try {
        await this.#disposeActive(name);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new ForgeError(
        'PLUGIN_DISPOSE_FAILED',
        'One or more plugins failed to unload',
        { errorCount: errors.length },
        { cause: new AggregateError(errors) },
      );
    }
  }

  async dispose(): Promise<void> {
    await this.unloadAll();
  }

  #verifyProvidedServices(plugin: DiscoveredPlugin, context: ForgeContext): void {
    const declared = [...(plugin.manifest.provides ?? [])].sort();
    const actual = this.#root
      .inspectServices()
      .services.filter((service) =>
        service.providers.some((provider) => provider.scopeId === context.id),
      )
      .map((service) => service.id)
      .sort();
    if (!isDeepStrictEqual(actual, declared)) {
      throw new ForgeError(
        'PLUGIN_LOAD_FAILED',
        `Plugin ${plugin.manifest.name} service registrations do not match its manifest`,
        { declared, actual },
      );
    }
  }

  async #disposeActive(name: string): Promise<void> {
    const active = this.#active.get(name);
    if (!active) return;
    this.#transition(active.plugin.manifest.name, 'stopping');
    this.#transition(active.plugin.manifest.name, 'unloading');
    try {
      await active.context.dispose();
    } finally {
      this.#active.delete(name);
      const index = this.#activeOrder.indexOf(name);
      if (index >= 0) this.#activeOrder.splice(index, 1);
      this.#transition(active.plugin.manifest.name, 'unloaded');
    }
  }

  #transition(name: PluginName, state: PluginLifecycleState): void {
    this.#options.onTransition?.(Object.freeze({ name, state }));
  }
}
