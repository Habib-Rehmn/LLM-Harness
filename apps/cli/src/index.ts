import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  BUILTIN_BUNDLES,
  BUILTIN_PROFILES,
  type ConfigObject,
  type ConfigValue,
  type ConfigurationLayers,
  type ConfigurationOverlay,
  diagnoseConfiguration,
  parseConfigurationOverlayToml,
} from '@forge/kernel-config';
import {
  ProviderRegistry,
  collectModelResponse,
  selectToolProtocol,
  type ModelDescriptor,
} from '@forge/llm-core';
import { OllamaProvider } from '@forge/provider-ollama';

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface CliRuntime {
  readonly cwd?: string;
  readonly home?: string;
  readonly loadDefaultFiles?: boolean;
  readonly providerRegistry?: ProviderRegistry;
}

const DEFAULT_IO: CliIo = {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function loadLayer(
  path: string,
  id: string,
  required: boolean,
): Promise<ConfigurationOverlay | undefined> {
  try {
    return parseConfigurationOverlayToml(await readFile(path, 'utf8'), id);
  } catch (error) {
    if (!required && isRecord(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function parseCliValue(text: string): ConfigValue {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      parsed === null ||
      typeof parsed === 'string' ||
      typeof parsed === 'number' ||
      typeof parsed === 'boolean' ||
      Array.isArray(parsed) ||
      isRecord(parsed)
    ) {
      return parsed as ConfigValue;
    }
  } catch {
    return text;
  }
  return text;
}

function cliOverlay(values: readonly string[]): ConfigurationOverlay | undefined {
  if (values.length === 0) return undefined;
  const settings: Record<string, ConfigValue> = {};
  for (const assignment of values) {
    const separator = assignment.indexOf('=');
    if (separator <= 0) throw new Error(`Invalid --set value: ${assignment}`);
    const path = assignment.slice(0, separator).split('.');
    if (
      path.some(
        (segment) => !segment || ['__proto__', 'prototype', 'constructor'].includes(segment),
      )
    ) {
      throw new Error(`Invalid --set path: ${assignment.slice(0, separator)}`);
    }
    let target: Record<string, ConfigValue> = settings;
    for (const segment of path.slice(0, -1)) {
      const existing = target[segment];
      if (!isRecord(existing)) target[segment] = {};
      target = target[segment] as Record<string, ConfigValue>;
    }
    const final = path.at(-1);
    if (!final) throw new Error(`Invalid --set path: ${assignment}`);
    target[final] = parseCliValue(assignment.slice(separator + 1));
  }
  return { id: 'command-line', settings: settings as ConfigObject };
}

export async function runCli(
  argv: readonly string[],
  io: CliIo = DEFAULT_IO,
  runtime: CliRuntime = {},
): Promise<number> {
  try {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        profile: { type: 'string', default: 'terminal' },
        'dump-config': { type: 'boolean', default: false },
        'user-config': { type: 'string' },
        'project-config': { type: 'string' },
        'local-config': { type: 'string' },
        'managed-config': { type: 'string' },
        set: { type: 'string', multiple: true, default: [] },
        'ollama-url': { type: 'string', default: 'http://127.0.0.1:11434' },
      },
    });
    if (parsed.positionals[0] === 'models') {
      const registry = runtime.providerRegistry ?? new ProviderRegistry();
      if (!runtime.providerRegistry) {
        registry.register(new OllamaProvider({ baseUrl: parsed.values['ollama-url'] }));
      }
      return await runModelsCommand(parsed.positionals, registry, io);
    }
    const cwd = resolve(runtime.cwd ?? process.cwd());
    const home = runtime.home ?? homedir();
    const loadDefaults = runtime.loadDefaultFiles ?? true;
    const paths = {
      user: parsed.values['user-config'] ?? join(home, '.config/forge/config.toml'),
      projectShared: parsed.values['project-config'] ?? join(cwd, '.forge/config.toml'),
      projectLocal: parsed.values['local-config'] ?? join(cwd, '.forge/config.local.toml'),
      managed: parsed.values['managed-config'],
    };
    const user =
      loadDefaults || parsed.values['user-config']
        ? await loadLayer(paths.user, paths.user, Boolean(parsed.values['user-config']))
        : undefined;
    const projectShared =
      loadDefaults || parsed.values['project-config']
        ? await loadLayer(
            paths.projectShared,
            paths.projectShared,
            Boolean(parsed.values['project-config']),
          )
        : undefined;
    const projectLocal =
      loadDefaults || parsed.values['local-config']
        ? await loadLayer(
            paths.projectLocal,
            paths.projectLocal,
            Boolean(parsed.values['local-config']),
          )
        : undefined;
    const cli = cliOverlay(parsed.values.set);
    const managed = paths.managed ? await loadLayer(paths.managed, paths.managed, true) : undefined;
    const layers: ConfigurationLayers = {
      ...(user === undefined ? {} : { user }),
      ...(projectShared === undefined ? {} : { projectShared }),
      ...(projectLocal === undefined ? {} : { projectLocal }),
      ...(cli === undefined ? {} : { cli }),
      ...(managed === undefined ? {} : { managed }),
    };
    const input = {
      profileId: parsed.values.profile,
      profiles: BUILTIN_PROFILES,
      bundles: BUILTIN_BUNDLES,
      layers,
    };
    const doctor = diagnoseConfiguration(input);
    const isDoctor = parsed.positionals[0] === 'config' && parsed.positionals[1] === 'doctor';
    const isDump = parsed.values['dump-config'];
    if (!isDoctor && !isDump) {
      throw new Error('Usage: forge --profile <name> --dump-config | forge config doctor');
    }
    if (parsed.positionals.length > (isDoctor ? 2 : 0)) {
      throw new Error(
        `Unexpected arguments: ${parsed.positionals.slice(isDoctor ? 2 : 0).join(' ')}`,
      );
    }
    io.stdout(JSON.stringify(isDoctor ? doctor : doctor.config, null, 2));
    return doctor.ok ? 0 : 1;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runModelsCommand(
  positionals: readonly string[],
  registry: ProviderRegistry,
  io: CliIo,
): Promise<number> {
  const command = positionals[1];
  if (command === 'list') {
    if (positionals.length !== 2) throw new Error('Usage: forge models list');
    const models = await registry.discoverModels();
    io.stdout(
      JSON.stringify(
        models.map((model) => ({
          reference: `${model.providerId}/${model.id}`,
          displayName: model.displayName,
          capabilities: model.capabilities,
          toolProtocol: selectToolProtocol(model.capabilities, { allowPromptedFallback: true }),
        })),
        null,
        2,
      ),
    );
    return 0;
  }
  if (command === 'test') {
    if (positionals.length !== 3) {
      throw new Error('Usage: forge models test <provider/model>');
    }
    const reference = positionals[2];
    if (!reference) throw new Error('A provider/model reference is required');
    const model = await registry.resolveModel(reference);
    const provider = registry.get(model.providerId);
    const result = await collectModelResponse(
      provider.generate({
        model: model.id,
        system: 'This is a read-only Forge provider conformance check.',
        messages: [
          {
            role: 'user',
            content:
              'Reply briefly, or call forge_read_probe with path README.md if tool calls are supported.',
          },
        ],
        ...(model.capabilities.nativeToolCalls
          ? {
              tools: [
                {
                  name: 'forge_read_probe',
                  description: 'Request a read-only file probe; this command does not execute it.',
                  inputSchema: {
                    type: 'object',
                    required: ['path'],
                    properties: { path: { type: 'string' } },
                    additionalProperties: false,
                  },
                },
              ],
              toolChoice: 'auto' as const,
            }
          : {}),
        maxOutputTokens: Math.min(128, model.capabilities.maxOutputTokens),
        temperature: 0,
      }),
    );
    io.stdout(
      JSON.stringify(
        {
          ok: true,
          model: summarizeModel(model),
          toolProtocol: selectToolProtocol(model.capabilities, { allowPromptedFallback: true }),
          response: result,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  throw new Error('Usage: forge models list | forge models test <provider/model>');
}

function summarizeModel(model: ModelDescriptor) {
  return {
    reference: `${model.providerId}/${model.id}`,
    displayName: model.displayName,
    capabilities: model.capabilities,
  };
}
