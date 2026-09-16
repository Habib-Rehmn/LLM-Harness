import {
  FORGE_API_VERSION,
  type ForgePlugin,
  pluginName,
  serviceToken,
} from '@forge/kernel-contracts';
import { TOOL_REGISTRY_SERVICE, type Tool } from '@forge/tools-core';
import { CONTEXT_PROVIDER_SERVICE } from './context.js';
import { RepositoryContext, type RepositoryContextOptions } from './repository.js';

export const REPOSITORY_CONTEXT_SERVICE = serviceToken<RepositoryContext>(
  'forge.repository-context',
);

export function createRepositoryTools(repository: RepositoryContext): readonly Tool[] {
  return [
    {
      definition: definition('repository.list', 'List eligible repository files.', {
        type: 'object',
        additionalProperties: false,
      }),
      async execute(_arguments, context) {
        const files = await repository.refresh(context.signal);
        return {
          text: files.map((file) => `${file.rootId}:${file.path}`).join('\n'),
          data: { count: files.length },
        };
      },
    },
    {
      definition: definition('repository.glob', 'Find eligible repository paths matching a glob.', {
        type: 'object',
        required: ['pattern'],
        properties: { pattern: { type: 'string' } },
        additionalProperties: false,
      }),
      async execute(arguments_, context) {
        const files = await repository.glob(requiredString(arguments_, 'pattern'), context.signal);
        return { text: files.map((file) => `${file.rootId}:${file.path}`).join('\n') };
      },
    },
    {
      definition: definition(
        'repository.search_text',
        'Search text in eligible repository files.',
        {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string' },
            maxResults: { type: 'integer', minimum: 1, maximum: 200 },
          },
          additionalProperties: false,
        },
      ),
      async execute(arguments_, context) {
        const matches = await repository.searchText(requiredString(arguments_, 'query'), {
          ...(typeof arguments_.maxResults === 'number'
            ? { maxResults: arguments_.maxResults }
            : {}),
          signal: context.signal,
        });
        return {
          text: matches
            .map(
              (match) =>
                `${match.rootId}:${match.path}:${match.line}:${match.column}: ${match.excerpt}`,
            )
            .join('\n'),
          data: { count: matches.length },
        };
      },
    },
    {
      definition: definition(
        'repository.read_file',
        'Read a bounded line range from an eligible repository file.',
        {
          type: 'object',
          required: ['rootId', 'path'],
          properties: {
            rootId: { type: 'string' },
            path: { type: 'string' },
            startLine: { type: 'integer', minimum: 1 },
            endLine: { type: 'integer', minimum: 1 },
          },
          additionalProperties: false,
        },
      ),
      async execute(arguments_, context) {
        const result = await repository.read(
          requiredString(arguments_, 'rootId'),
          requiredString(arguments_, 'path'),
          {
            ...(typeof arguments_.startLine === 'number'
              ? { startLine: arguments_.startLine }
              : {}),
            ...(typeof arguments_.endLine === 'number' ? { endLine: arguments_.endLine } : {}),
            signal: context.signal,
          },
        );
        return {
          text: result.content,
          data: {
            rootId: result.rootId,
            path: result.path,
            startLine: result.startLine,
            endLine: result.endLine,
            hash: result.hash,
            truncated: result.truncated,
          },
        };
      },
    },
  ];
}

function definition(
  name: string,
  description: string,
  inputSchema: Tool['definition']['inputSchema'],
) {
  return {
    name,
    version: '1.0.0',
    description,
    inputSchema,
    capabilities: ['workspace.read'],
    risk: 'safe' as const,
    readOnly: true,
    idempotent: true,
    timeoutMs: 30_000,
    maxOutputBytes: 128_000,
    maxOutputLines: 2_000,
    origin: 'official-plugin' as const,
    visibility: name === 'repository.list' ? ('lazy' as const) : ('always' as const),
    keywords: ['repository', 'code', 'files'],
  };
}

function requiredString(arguments_: Readonly<Record<string, unknown>>, key: string): string {
  const value = arguments_[key];
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value;
}

export function createRepositoryContextPlugin(options: RepositoryContextOptions): ForgePlugin {
  return {
    manifest: {
      apiVersion: FORGE_API_VERSION,
      name: pluginName('forge-repository-context'),
      version: '0.1.0',
      runtime: 'trusted',
      entrypoint: './lib/index.js',
      optional: { [TOOL_REGISTRY_SERVICE.id]: '^0.1.0' },
      provides: [REPOSITORY_CONTEXT_SERVICE.id, CONTEXT_PROVIDER_SERVICE.id],
      permissions: { filesystem: { read: options.roots.map((root) => root.path) } },
    },
    setup(context) {
      const repository = new RepositoryContext(options);
      context.provide(REPOSITORY_CONTEXT_SERVICE, repository);
      context.provide(CONTEXT_PROVIDER_SERVICE, repository);
      const tools = context.optional(TOOL_REGISTRY_SERVICE);
      if (tools) {
        for (const tool of createRepositoryTools(repository)) {
          context.effect(tools.register(tool));
        }
      }
    },
  };
}
