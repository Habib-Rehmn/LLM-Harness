import { ForgeError } from '@forge/kernel-contracts';
import { valid } from 'semver';
import { parse as parseToml } from 'smol-toml';

export type ConfigScalar = string | number | boolean | null;
export type ConfigValue =
  | ConfigScalar
  | readonly ConfigValue[]
  | { readonly [key: string]: ConfigValue };
export type ConfigObject = Readonly<Record<string, ConfigValue>>;

export type ConfigSourceKind =
  | 'defaults'
  | 'profile'
  | 'bundle'
  | 'user'
  | 'project-shared'
  | 'project-local'
  | 'cli'
  | 'managed';

export interface ConfigSource {
  readonly kind: ConfigSourceKind;
  readonly id: string;
}

export interface PluginConfigRow {
  readonly id: string;
  readonly package: string;
  readonly enabled?: boolean;
  readonly config?: ConfigObject;
  readonly permissions?: ConfigObject;
  readonly provides?: readonly string[];
}

export interface OrderedPluginConfigRow extends PluginConfigRow {
  readonly after?: string;
}

export interface BundleDefinition {
  readonly id: string;
  readonly version: string;
  readonly settings?: ConfigObject;
  readonly plugins?: readonly OrderedPluginConfigRow[];
}

export interface ProfileDefinition {
  readonly id: string;
  readonly bundles: readonly string[];
}

export type ConfigPatchOperation = 'merge' | 'replace' | 'remove';

export interface PluginConfigPatch {
  readonly id: string;
  readonly operation?: ConfigPatchOperation;
  readonly after?: string;
  readonly row?: Partial<PluginConfigRow>;
}

export interface ConfigurationOverlay {
  readonly id: string;
  readonly settings?: ConfigObject;
  readonly plugins?: readonly PluginConfigPatch[];
}

export interface ConfigurationDefaults {
  readonly settings?: ConfigObject;
  readonly plugins?: readonly OrderedPluginConfigRow[];
}

export interface ConfigurationLayers {
  readonly user?: ConfigurationOverlay;
  readonly projectShared?: ConfigurationOverlay;
  readonly projectLocal?: ConfigurationOverlay;
  readonly cli?: ConfigurationOverlay;
  readonly managed?: ConfigurationOverlay;
}

export interface ConfigurationInput {
  readonly profileId: string;
  readonly profiles: readonly ProfileDefinition[];
  readonly bundles: readonly BundleDefinition[];
  readonly defaults?: ConfigurationDefaults;
  readonly layers?: ConfigurationLayers;
}

export interface ResolvedProfile {
  readonly id: string;
  readonly bundles: readonly string[];
}

export interface ResolvedConfiguration {
  readonly profile: ResolvedProfile;
  readonly settings: ConfigObject;
  readonly plugins: readonly PluginConfigRow[];
  readonly serviceProviders: Readonly<Record<string, readonly string[]>>;
  readonly provenance: Readonly<Record<string, ConfigSource>>;
  readonly orderingReasons: readonly string[];
}

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export interface ConfigDiagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly source?: ConfigSource;
}

export interface ConfigDoctorResult {
  readonly ok: boolean;
  readonly diagnostics: readonly ConfigDiagnostic[];
  readonly config: ResolvedConfiguration | null;
}

interface MutableState {
  readonly settings: Record<string, ConfigValue>;
  readonly plugins: PluginConfigRow[];
  readonly provenance: Record<string, ConfigSource>;
  readonly orderingReasons: string[];
}

const SENSITIVE_KEY = /(?:api[-_]?key|authorization|credential|password|secret|token)$/i;
const PLACEHOLDER = /\$\{[^}]+\}|\{\{[^}]+\}\}/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function invalid(message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new ForgeError('INVALID_CONFIG', message, details);
}

function assertIdentifier(kind: string, value: string): void {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value)) {
    invalid(`${kind} must use lower-case dot/hyphen-separated segments`, { value });
  }
}

function assertUnique(values: readonly string[], kind: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) invalid(`Duplicate ${kind} ${value}`, { value });
    seen.add(value);
  }
}

function deleteProvenance(provenance: Record<string, ConfigSource>, prefix: string): void {
  for (const path of Object.keys(provenance)) {
    if (path === prefix || path.startsWith(`${prefix}/`)) delete provenance[path];
  }
}

function recordProvenance(
  provenance: Record<string, ConfigSource>,
  path: string,
  value: ConfigValue | PluginConfigRow,
  source: ConfigSource,
): void {
  if (Array.isArray(value)) {
    if (value.length === 0) provenance[path] = source;
    else {
      for (const [index, child] of value.entries()) {
        recordProvenance(provenance, `${path}/${index}`, child, source);
      }
    }
    return;
  }
  if (!isRecord(value) || Object.keys(value).length === 0) {
    provenance[path] = source;
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    recordProvenance(provenance, `${path}/${pointerSegment(key)}`, child as ConfigValue, source);
  }
}

function updateProvenance(
  provenance: Record<string, ConfigSource>,
  path: string,
  value: ConfigValue | Partial<PluginConfigRow>,
  source: ConfigSource,
): void {
  if (isRecord(value) && !Array.isArray(value) && Object.keys(value).length > 0) {
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      updateProvenance(provenance, `${path}/${pointerSegment(key)}`, child as ConfigValue, source);
    }
    return;
  }
  deleteProvenance(provenance, path);
  recordProvenance(provenance, path, value as ConfigValue, source);
}

function mergeObject(
  target: Record<string, ConfigValue>,
  incoming: ConfigObject,
  path: string,
  source: ConfigSource,
  provenance: Record<string, ConfigSource>,
): void {
  for (const [key, value] of Object.entries(incoming)) {
    const childPath = `${path}/${pointerSegment(key)}`;
    const current = target[key];
    if (isRecord(current) && isRecord(value) && !Array.isArray(current) && !Array.isArray(value)) {
      mergeObject(
        current as Record<string, ConfigValue>,
        value as ConfigObject,
        childPath,
        source,
        provenance,
      );
      continue;
    }
    target[key] = cloneValue(value);
    deleteProvenance(provenance, childPath);
    recordProvenance(provenance, childPath, value, source);
  }
}

function normalizeRow(row: OrderedPluginConfigRow | PluginConfigRow): PluginConfigRow {
  assertIdentifier('plugin row id', row.id);
  if (typeof row.package !== 'string' || row.package.trim().length === 0) {
    invalid(`Plugin row ${row.id} requires a package`);
  }
  if (row.enabled !== undefined && typeof row.enabled !== 'boolean') {
    invalid(`Plugin row ${row.id} enabled must be boolean`);
  }
  if (row.config !== undefined && !isRecord(row.config)) {
    invalid(`Plugin row ${row.id} config must be an object`);
  }
  if (row.permissions !== undefined && !isRecord(row.permissions)) {
    invalid(`Plugin row ${row.id} permissions must be an object`);
  }
  if (row.provides !== undefined) {
    if (
      !Array.isArray(row.provides) ||
      row.provides.some((service) => typeof service !== 'string')
    ) {
      invalid(`Plugin row ${row.id} provides must be a string array`);
    }
    assertUnique(row.provides, `provided service in plugin row ${row.id}`);
    for (const service of row.provides) assertIdentifier('service id', service);
  }
  return cloneValue({
    id: row.id,
    package: row.package,
    ...(row.enabled === undefined ? {} : { enabled: row.enabled }),
    ...(row.config === undefined ? {} : { config: row.config }),
    ...(row.permissions === undefined ? {} : { permissions: row.permissions }),
    ...(row.provides === undefined ? {} : { provides: row.provides }),
  });
}

function deepMergeConfig(previous: ConfigObject, incoming: ConfigObject): ConfigObject {
  const output = cloneValue(previous) as Record<string, ConfigValue>;
  for (const [key, value] of Object.entries(incoming)) {
    const current = output[key];
    output[key] =
      isRecord(current) && isRecord(value)
        ? deepMergeConfig(current as ConfigObject, value as ConfigObject)
        : cloneValue(value);
  }
  return output;
}

function placeRow(
  rows: PluginConfigRow[],
  row: PluginConfigRow,
  after: string | undefined,
  existingIndex: number,
): void {
  if (after === row.id) invalid(`Plugin row ${row.id} cannot be ordered after itself`);
  if (existingIndex >= 0) rows.splice(existingIndex, 1);
  if (after === undefined) {
    const index = existingIndex >= 0 ? Math.min(existingIndex, rows.length) : rows.length;
    rows.splice(index, 0, row);
    return;
  }
  const anchor = rows.findIndex((candidate) => candidate.id === after);
  if (anchor < 0) invalid(`Plugin row ${row.id} references missing ordering anchor ${after}`);
  rows.splice(anchor + 1, 0, row);
}

function applyFullRows(
  state: MutableState,
  rows: readonly OrderedPluginConfigRow[],
  source: ConfigSource,
): void {
  assertUnique(
    rows.map((row) => row.id),
    'plugin row',
  );
  for (const candidate of rows) {
    const row = normalizeRow(candidate);
    const existing = state.plugins.findIndex((entry) => entry.id === row.id);
    placeRow(state.plugins, row, candidate.after, existing);
    const path = `/plugins/${pointerSegment(row.id)}`;
    deleteProvenance(state.provenance, path);
    recordProvenance(state.provenance, path, row, source);
    state.orderingReasons.push(
      existing >= 0
        ? `${row.id} replaced by ${source.kind}:${source.id}`
        : `${row.id} inserted by ${source.kind}:${source.id}${candidate.after ? ` after ${candidate.after}` : ''}`,
    );
  }
}

function mergeRow(
  existing: PluginConfigRow | undefined,
  patch: PluginConfigPatch,
): PluginConfigRow {
  const changes = patch.row ?? {};
  const base = existing ? cloneValue(existing) : ({ id: patch.id } as Partial<PluginConfigRow>);
  const merged = { ...base, ...cloneValue(changes), id: patch.id };
  for (const key of ['config', 'permissions'] as const) {
    const previous = existing?.[key];
    const incoming = changes[key];
    if (previous && incoming) {
      merged[key] = deepMergeConfig(previous, incoming);
    }
  }
  return normalizeRow(merged as PluginConfigRow);
}

function applyOverlay(
  state: MutableState,
  overlay: ConfigurationOverlay,
  kind: Exclude<ConfigSourceKind, 'defaults' | 'profile' | 'bundle'>,
): void {
  const source = freezeDeep({ kind, id: overlay.id });
  if (overlay.settings) {
    mergeObject(state.settings, overlay.settings, '/settings', source, state.provenance);
  }
  assertUnique(
    (overlay.plugins ?? []).map((patch) => patch.id),
    `plugin patch in ${kind}:${overlay.id}`,
  );
  for (const patch of overlay.plugins ?? []) {
    assertIdentifier('plugin patch id', patch.id);
    const operation = patch.operation ?? 'merge';
    const existingIndex = state.plugins.findIndex((row) => row.id === patch.id);
    const existing = state.plugins[existingIndex];
    const path = `/plugins/${pointerSegment(patch.id)}`;
    if (operation === 'remove') {
      if (patch.row) invalid(`Remove patch ${patch.id} cannot include row values`);
      if (existingIndex < 0) invalid(`Cannot remove missing plugin row ${patch.id}`);
      state.plugins.splice(existingIndex, 1);
      deleteProvenance(state.provenance, path);
      state.orderingReasons.push(`${patch.id} removed by ${kind}:${overlay.id}`);
      continue;
    }

    let row: PluginConfigRow;
    if (operation === 'replace') {
      if (!patch.row) invalid(`Replace patch ${patch.id} requires row values`);
      row = normalizeRow({ ...patch.row, id: patch.id } as PluginConfigRow);
      deleteProvenance(state.provenance, path);
      recordProvenance(state.provenance, path, row, source);
    } else {
      row = mergeRow(existing, patch);
      if (patch.row) {
        updateProvenance(
          state.provenance,
          path,
          { ...patch.row, id: patch.id } as PluginConfigRow,
          source,
        );
      }
    }
    placeRow(state.plugins, row, patch.after, existingIndex);
    state.orderingReasons.push(
      `${patch.id} ${existing ? operation : 'inserted'} by ${kind}:${overlay.id}${patch.after ? ` after ${patch.after}` : ''}`,
    );
  }
}

function buildServiceProviders(
  rows: readonly PluginConfigRow[],
): Record<string, readonly string[]> {
  const providers: Record<string, string[]> = {};
  for (const row of rows) {
    if (row.enabled === false) continue;
    for (const service of row.provides ?? []) {
      const entries = providers[service] ?? [];
      entries.push(row.id);
      providers[service] = entries;
    }
  }
  return providers;
}

export function resolveConfiguration(input: ConfigurationInput): ResolvedConfiguration {
  assertIdentifier('profile id', input.profileId);
  assertUnique(
    input.profiles.map((profile) => profile.id),
    'profile',
  );
  assertUnique(
    input.bundles.map((bundle) => bundle.id),
    'bundle',
  );
  const profile = input.profiles.find((candidate) => candidate.id === input.profileId);
  if (!profile) invalid(`Unknown profile ${input.profileId}`, { profile: input.profileId });
  assertUnique(profile.bundles, `bundle reference in profile ${profile.id}`);
  const bundles = new Map(input.bundles.map((bundle) => [bundle.id, bundle]));
  const state: MutableState = {
    settings: {},
    plugins: [],
    provenance: {},
    orderingReasons: [],
  };
  const profileSource = freezeDeep({ kind: 'profile' as const, id: profile.id });
  state.provenance['/profile/id'] = profileSource;
  state.provenance['/profile/bundles'] = profileSource;

  const defaultSource = freezeDeep({ kind: 'defaults' as const, id: 'host' });
  if (input.defaults?.settings) {
    mergeObject(
      state.settings,
      input.defaults.settings,
      '/settings',
      defaultSource,
      state.provenance,
    );
  }
  if (input.defaults?.plugins) applyFullRows(state, input.defaults.plugins, defaultSource);

  for (const bundleId of profile.bundles) {
    const bundle = bundles.get(bundleId);
    if (!bundle) invalid(`Profile ${profile.id} references unknown bundle ${bundleId}`);
    assertIdentifier('bundle id', bundle.id);
    if (!valid(bundle.version)) invalid(`Bundle ${bundle.id} requires a semantic version`);
    const source = freezeDeep({ kind: 'bundle' as const, id: `${bundle.id}@${bundle.version}` });
    if (bundle.settings) {
      mergeObject(state.settings, bundle.settings, '/settings', source, state.provenance);
    }
    if (bundle.plugins) applyFullRows(state, bundle.plugins, source);
  }

  const layers = input.layers ?? {};
  if (layers.user) applyOverlay(state, layers.user, 'user');
  if (layers.projectShared) applyOverlay(state, layers.projectShared, 'project-shared');
  if (layers.projectLocal) applyOverlay(state, layers.projectLocal, 'project-local');
  if (layers.cli) applyOverlay(state, layers.cli, 'cli');
  if (layers.managed) applyOverlay(state, layers.managed, 'managed');

  const resolved: ResolvedConfiguration = {
    profile: { id: profile.id, bundles: [...profile.bundles] },
    settings: state.settings,
    plugins: state.plugins,
    serviceProviders: buildServiceProviders(state.plugins),
    provenance: state.provenance,
    orderingReasons: state.orderingReasons,
  };
  return freezeDeep(resolved);
}

function redactValue(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry));
  if (!isRecord(value)) return value;
  if (typeof value.secretRef === 'string') return { secretRef: '[REDACTED]' };
  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [childKey, redactValue(child, childKey)]),
  );
}

export function redactConfiguration(config: ResolvedConfiguration): ResolvedConfiguration {
  return freezeDeep(redactValue(config) as ResolvedConfiguration);
}

function inspectValue(
  value: unknown,
  path: string,
  config: ResolvedConfiguration,
  diagnostics: ConfigDiagnostic[],
  key = '',
): void {
  if (typeof value === 'string' && PLACEHOLDER.test(value)) {
    const source = config.provenance[path];
    diagnostics.push({
      severity: 'error',
      code: 'UNRESOLVED_PLACEHOLDER',
      message: `Unresolved placeholder at ${path}`,
      path,
      ...(source === undefined ? {} : { source }),
    });
  }
  if (SENSITIVE_KEY.test(key) && !(isRecord(value) && typeof value.secretRef === 'string')) {
    const source = config.provenance[path];
    diagnostics.push({
      severity: 'warning',
      code: 'SECRET_LITERAL',
      message: `Sensitive value at ${path} should use a secret reference`,
      path,
      ...(source === undefined ? {} : { source }),
    });
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      inspectValue(child, `${path}/${index}`, config, diagnostics);
    }
  } else if (isRecord(value)) {
    for (const [childKey, child] of Object.entries(value)) {
      inspectValue(child, `${path}/${pointerSegment(childKey)}`, config, diagnostics, childKey);
    }
  }
}

export function diagnoseConfiguration(input: ConfigurationInput): ConfigDoctorResult {
  try {
    const resolved = resolveConfiguration(input);
    const diagnostics: ConfigDiagnostic[] = [];
    inspectValue(resolved.settings, '/settings', resolved, diagnostics);
    for (const row of resolved.plugins) {
      inspectValue(row, `/plugins/${pointerSegment(row.id)}`, resolved, diagnostics);
    }
    diagnostics.sort((left, right) =>
      `${left.severity}:${left.path ?? ''}:${left.code}`.localeCompare(
        `${right.severity}:${right.path ?? ''}:${right.code}`,
      ),
    );
    return freezeDeep({
      ok: !diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
      diagnostics,
      config: redactConfiguration(resolved),
    });
  } catch (error) {
    const forgeError = error instanceof ForgeError ? error : undefined;
    return freezeDeep({
      ok: false,
      diagnostics: [
        {
          severity: 'error',
          code: forgeError?.code ?? 'INVALID_CONFIG',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      config: null,
    });
  }
}

function asConfigValue(value: unknown, path: string): ConfigValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value))
    return value.map((child, index) => asConfigValue(child, `${path}/${index}`));
  if (isRecord(value) && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, asConfigValue(child, `${path}/${key}`)]),
    );
  }
  invalid(`Unsupported configuration value at ${path}`);
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0)
    invalid(`Unknown configuration keys at ${path}: ${unknown.sort().join(', ')}`);
}

export function parseConfigurationOverlayToml(text: string, id: string): ConfigurationOverlay {
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch (error) {
    throw new ForgeError(
      'INVALID_CONFIG',
      `Cannot parse TOML layer ${id}`,
      { id },
      { cause: error },
    );
  }
  if (!isRecord(parsed)) invalid(`Configuration layer ${id} must be a table`);
  assertKeys(parsed, ['settings', 'plugins'], '/');
  const settings = parsed.settings;
  if (settings !== undefined && !isRecord(settings))
    invalid(`Layer ${id} settings must be a table`);
  const rawPlugins = parsed.plugins;
  if (rawPlugins !== undefined && !Array.isArray(rawPlugins)) {
    invalid(`Layer ${id} plugins must be an array of tables`);
  }

  const plugins = (rawPlugins ?? []).map((raw, index): PluginConfigPatch => {
    if (!isRecord(raw)) invalid(`Plugin patch ${index} in ${id} must be a table`);
    assertKeys(
      raw,
      ['id', 'operation', 'after', 'package', 'enabled', 'config', 'permissions', 'provides'],
      `/plugins/${index}`,
    );
    if (typeof raw.id !== 'string') invalid(`Plugin patch ${index} in ${id} requires an id`);
    if (
      raw.operation !== undefined &&
      raw.operation !== 'merge' &&
      raw.operation !== 'replace' &&
      raw.operation !== 'remove'
    ) {
      invalid(`Plugin patch ${raw.id} has an invalid operation`);
    }
    if (raw.after !== undefined && typeof raw.after !== 'string') {
      invalid(`Plugin patch ${raw.id} has an invalid after value`);
    }
    const rowEntries = Object.entries(raw).filter(
      ([key]) => !['id', 'operation', 'after'].includes(key),
    );
    const row =
      rowEntries.length === 0
        ? undefined
        : (asConfigValue(
            Object.fromEntries(rowEntries),
            `/plugins/${index}`,
          ) as Partial<PluginConfigRow>);
    return {
      id: raw.id,
      ...(raw.operation === undefined ? {} : { operation: raw.operation }),
      ...(raw.after === undefined ? {} : { after: raw.after }),
      ...(row === undefined ? {} : { row }),
    };
  });

  return freezeDeep({
    id,
    ...(settings === undefined
      ? {}
      : { settings: asConfigValue(settings, '/settings') as ConfigObject }),
    ...(plugins.length === 0 ? {} : { plugins }),
  });
}

export const BUILTIN_BUNDLES: readonly BundleDefinition[] = freezeDeep([
  { id: 'forge-base', version: '0.1.0', plugins: [] },
  { id: 'forge-local-execution', version: '0.1.0', plugins: [] },
  { id: 'forge-terminal', version: '0.1.0', plugins: [] },
  { id: 'forge-headless', version: '0.1.0', plugins: [] },
]);

export const BUILTIN_PROFILES: readonly ProfileDefinition[] = freezeDeep([
  {
    id: 'terminal',
    bundles: ['forge-base', 'forge-local-execution', 'forge-terminal'],
  },
  {
    id: 'headless',
    bundles: ['forge-base', 'forge-local-execution', 'forge-headless'],
  },
]);
