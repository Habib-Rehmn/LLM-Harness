import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import {
  FORGE_API_VERSION,
  type ForgeDecision,
  type ForgePlugin,
  pluginName,
  serviceToken,
} from '@forge/kernel-contracts';
import type { JsonObject, JsonValue } from '@forge/llm-core';
import {
  TOOL_REGISTRY_SERVICE,
  type Tool,
  type ToolArtifact,
  type ToolRegistry,
} from '@forge/tools-core';

interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  readonly abort?: () => void;
}

export class McpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'McpRpcError';
  }
}

export interface McpStdioOptions {
  readonly id: string;
  readonly command: readonly [string, ...string[]];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly requestTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
  readonly maxOutputBytes?: number;
}

interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
  };
}

export class McpStdioClient {
  readonly #options: McpStdioOptions;
  readonly #pending = new Map<number, PendingRequest>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #buffer = '';
  #nextId = 1;
  #modern = true;

  constructor(options: McpStdioOptions) {
    if (!/^[a-z][a-z0-9_]*$/.test(options.id)) throw new Error('MCP server id must be snake_case');
    if (options.command.length === 0) throw new Error('MCP command is required');
    this.#options = options;
  }

  async discover(): Promise<readonly Tool[]> {
    await this.#start();
    let response: unknown;
    try {
      response = await this.#request('tools/list', {});
    } catch (error) {
      if (!(error instanceof McpRpcError) || error.code !== -32601) throw error;
      this.#modern = false;
      response = await this.#request('listTools', {});
    }
    const descriptors = toolDescriptors(response);
    const names = new Set<string>();
    return descriptors.map((descriptor) => {
      const localName = `mcp.${this.#options.id}.${safeSegment(descriptor.name)}`;
      if (names.has(localName)) throw new Error(`MCP tool name collision: ${localName}`);
      names.add(localName);
      return this.#tool(localName, descriptor);
    });
  }

  async register(registry: ToolRegistry): Promise<() => Promise<void>> {
    const disposers = (await this.discover()).map((tool) => registry.register(tool));
    return async () => {
      for (const dispose of disposers.reverse()) dispose();
      await this.close();
    };
  }

  async close(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    if (!child) return;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener('abort', pending.abort ?? noop);
      pending.reject(new Error('MCP client closed'));
    }
    this.#pending.clear();
    child.stdin.end();
    if (child.exitCode === null) child.kill('SIGTERM');
  }

  #tool(localName: string, descriptor: McpToolDescriptor): Tool {
    const annotations = descriptor.annotations ?? {};
    const readOnly = annotations.readOnlyHint === true;
    return {
      definition: {
        name: localName,
        version: '0.1.0',
        description: descriptor.description?.trim() || `MCP tool ${descriptor.name}`,
        inputSchema: inputSchema(descriptor.inputSchema),
        capabilities: [`mcp:${this.#options.id}`, `mcp-tool:${descriptor.name}`],
        risk: annotations.destructiveHint ? 'destructive' : readOnly ? 'safe' : 'sensitive',
        readOnly,
        idempotent: annotations.idempotentHint === true,
        timeoutMs: this.#options.toolTimeoutMs ?? 30_000,
        maxOutputBytes: this.#options.maxOutputBytes ?? 64 * 1_024,
        origin: 'mcp',
        visibility: 'lazy',
        keywords: ['mcp', this.#options.id, descriptor.name],
      },
      execute: async (arguments_, context) => {
        const method = this.#modern ? 'tools/call' : 'callTool';
        const result = await this.#request(
          method,
          { name: descriptor.name, arguments: arguments_ },
          context.signal,
        );
        return normalizeToolResult(result);
      },
    };
  }

  async #start(): Promise<void> {
    if (this.#child) return;
    const [command, ...arguments_] = this.#options.command;
    const child = spawn(command, arguments_, {
      cwd: this.#options.cwd,
      env: { ...process.env, ...this.#options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.#receive(chunk));
    child.once('error', (error) => this.#fail(error));
    child.once('exit', (code, signal) => {
      if (this.#child === child) this.#child = undefined;
      this.#fail(new Error(`MCP server exited (${code ?? signal ?? 'unknown'})`));
    });
    await this.#request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'forge', version: '0.1.0' },
    });
    this.#notify('notifications/initialized', {});
  }

  #notify(method: string, params: JsonObject): void {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  #request(method: string, params: JsonObject, signal?: AbortSignal): Promise<unknown> {
    const id = this.#nextId++;
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('MCP request aborted'));
    return new Promise((resolve, reject) => {
      const finishReject = (error: Error) => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.signal?.removeEventListener('abort', pending.abort ?? noop);
        reject(error);
      };
      const timer = setTimeout(
        () => finishReject(new Error(`MCP request timed out: ${method}`)),
        this.#options.requestTimeoutMs ?? 10_000,
      );
      const abort = () => finishReject(asError(signal?.reason, 'MCP request aborted'));
      this.#pending.set(id, { resolve, reject, timer, ...(signal ? { signal, abort } : {}) });
      signal?.addEventListener('abort', abort, { once: true });
      try {
        this.#write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        finishReject(asError(error, 'Could not write MCP request'));
      }
    });
  }

  #write(message: unknown): void {
    const child = this.#child;
    if (!child?.stdin.writable) throw new Error('MCP server is not running');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #receive(chunk: string): void {
    this.#buffer += chunk;
    while (true) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      let response: JsonRpcResponse;
      try {
        response = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (!Number.isSafeInteger(response.id)) continue;
      const pending = this.#pending.get(response.id);
      if (!pending) continue;
      this.#pending.delete(response.id);
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener('abort', pending.abort ?? noop);
      if (response.error) {
        pending.reject(
          new McpRpcError(response.error.code, response.error.message, response.error.data),
        );
      } else {
        pending.resolve(response.result);
      }
    }
  }

  #fail(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener('abort', pending.abort ?? noop);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export type LifecyclePhase =
  | 'session.start'
  | 'prompt.before'
  | 'tool.before'
  | 'tool.after'
  | 'response.after'
  | 'session.end';

export interface HookResult {
  readonly decision: ForgeDecision;
  readonly reason?: string;
  readonly patch?: Readonly<Record<string, unknown>>;
}

export interface LifecycleHook {
  readonly id: string;
  readonly phase: LifecyclePhase;
  readonly timeoutMs?: number;
  run(
    payload: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): HookResult | Promise<HookResult>;
}

export interface HookRunResult {
  readonly decision: ForgeDecision;
  readonly reason?: string;
  readonly hookId?: string;
  readonly patches: readonly Readonly<Record<string, unknown>>[];
}

export class LifecycleHookRegistry {
  readonly #hooks = new Map<string, LifecycleHook>();

  register(hook: LifecycleHook): () => void {
    if (!/^[a-z][a-z0-9_.-]*$/.test(hook.id)) throw new Error(`Invalid hook id: ${hook.id}`);
    if (this.#hooks.has(hook.id)) throw new Error(`Hook ${hook.id} is already registered`);
    this.#hooks.set(hook.id, hook);
    return () => {
      if (this.#hooks.get(hook.id) === hook) this.#hooks.delete(hook.id);
    };
  }

  async run(
    phase: LifecyclePhase,
    payload: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<HookRunResult> {
    const patches: Readonly<Record<string, unknown>>[] = [];
    let provisional: HookRunResult | undefined;
    for (const hook of this.#hooks.values()) {
      if (hook.phase !== phase) continue;
      const result = await runHook(hook, payload, signal);
      if (result.patch) patches.push(result.patch);
      if (result.decision === 'deny') {
        return {
          decision: 'deny',
          ...(result.reason ? { reason: result.reason } : {}),
          hookId: hook.id,
          patches,
        };
      }
      if (result.decision === 'ask' && !provisional) {
        provisional = {
          decision: 'ask',
          ...(result.reason ? { reason: result.reason } : {}),
          hookId: hook.id,
          patches,
        };
      } else if (result.decision === 'allow' && !provisional) {
        provisional = {
          decision: 'allow',
          ...(result.reason ? { reason: result.reason } : {}),
          hookId: hook.id,
          patches,
        };
      }
    }
    return provisional ? { ...provisional, patches } : { decision: 'delegate', patches };
  }
}

export interface SkillMetadata {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly keywords: readonly string[];
}

export interface SkillRegistration extends SkillMetadata {
  load(): string | Promise<string>;
}

export class SkillRegistry {
  readonly #skills = new Map<string, SkillRegistration>();
  readonly #maximumBytes: number;

  constructor(maximumBytes = 256 * 1_024) {
    this.#maximumBytes = maximumBytes;
  }

  register(skill: SkillRegistration): () => void {
    if (!/^[a-z][a-z0-9_.-]*$/.test(skill.id)) throw new Error(`Invalid skill id: ${skill.id}`);
    if (this.#skills.has(skill.id)) throw new Error(`Skill ${skill.id} is already registered`);
    this.#skills.set(skill.id, skill);
    return () => {
      if (this.#skills.get(skill.id) === skill) this.#skills.delete(skill.id);
    };
  }

  discover(query = ''): readonly SkillMetadata[] {
    const terms = words(query);
    return [...this.#skills.values()]
      .filter((skill) => {
        if (terms.length === 0) return true;
        const haystack = words(
          `${skill.id} ${skill.name} ${skill.description} ${skill.keywords.join(' ')}`,
        );
        return terms.some((term) => haystack.some((word) => word.includes(term)));
      })
      .map(({ id, name, description, keywords }) => ({ id, name, description, keywords }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async load(id: string): Promise<string> {
    const skill = this.#skills.get(id);
    if (!skill) throw new Error(`Unknown skill: ${id}`);
    const body = await skill.load();
    if (Buffer.byteLength(body) > this.#maximumBytes)
      throw new Error(`Skill ${id} exceeds size limit`);
    return body;
  }
}

export function fileSkill(
  root: string,
  relativePath: string,
  metadata: SkillMetadata,
): SkillRegistration {
  return {
    ...metadata,
    async load() {
      const canonicalRoot = await realpath(root);
      const canonicalPath = await realpath(resolve(canonicalRoot, relativePath));
      const traversal = relative(canonicalRoot, canonicalPath);
      if (traversal.startsWith('..') || resolve(canonicalRoot, traversal) !== canonicalPath) {
        throw new Error(`Skill ${metadata.id} escapes its root`);
      }
      return readFile(canonicalPath, 'utf8');
    },
  };
}

export const LIFECYCLE_HOOKS_SERVICE = serviceToken<LifecycleHookRegistry>('forge.lifecycle-hooks');
export const SKILLS_SERVICE = serviceToken<SkillRegistry>('forge.skills');

export function createExtensionRuntimePlugin(
  options: {
    readonly hooks?: readonly LifecycleHook[];
    readonly skills?: readonly SkillRegistration[];
  } = {},
): ForgePlugin {
  return {
    manifest: {
      apiVersion: FORGE_API_VERSION,
      name: pluginName('forge-extension-runtime'),
      version: '0.1.0',
      runtime: 'trusted',
      entrypoint: './lib/index.js',
      provides: [LIFECYCLE_HOOKS_SERVICE.id, SKILLS_SERVICE.id],
      contributes: {
        hooks: options.hooks?.map(({ id }) => id) ?? [],
        skills: options.skills?.map(({ id }) => id) ?? [],
      },
      permissions: {},
    },
    setup(context) {
      const hooks = new LifecycleHookRegistry();
      const skills = new SkillRegistry();
      for (const hook of options.hooks ?? []) hooks.register(hook);
      for (const skill of options.skills ?? []) skills.register(skill);
      context.provide(LIFECYCLE_HOOKS_SERVICE, hooks);
      context.provide(SKILLS_SERVICE, skills);
    },
  };
}

export function createLifecycleHookPlugin(
  id: string,
  hooks: readonly LifecycleHook[],
): ForgePlugin {
  return {
    manifest: contributionManifest(
      id,
      'hooks',
      hooks.map((hook) => hook.id),
      LIFECYCLE_HOOKS_SERVICE.id,
    ),
    setup(context) {
      const registry = context.get(LIFECYCLE_HOOKS_SERVICE);
      for (const hook of hooks) context.effect(registry.register(hook));
    },
  };
}

export function createSkillPlugin(id: string, skills: readonly SkillRegistration[]): ForgePlugin {
  return {
    manifest: contributionManifest(
      id,
      'skills',
      skills.map((skill) => skill.id),
      SKILLS_SERVICE.id,
    ),
    setup(context) {
      const registry = context.get(SKILLS_SERVICE);
      for (const skill of skills) context.effect(registry.register(skill));
    },
  };
}

export function createMcpPlugin(client: McpStdioClient): ForgePlugin {
  return {
    manifest: {
      apiVersion: FORGE_API_VERSION,
      name: pluginName('forge-mcp-client'),
      version: '0.1.0',
      runtime: 'trusted',
      entrypoint: './lib/index.js',
      requires: { [TOOL_REGISTRY_SERVICE.id]: '^0.1.0' },
      permissions: { subprocess: true },
    },
    async setup(context) {
      const dispose = await client.register(context.get(TOOL_REGISTRY_SERVICE));
      context.effect(dispose);
    },
  };
}

async function runHook(
  hook: LifecycleHook,
  payload: Readonly<Record<string, unknown>>,
  parentSignal?: AbortSignal,
): Promise<HookResult> {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error('hook timeout'));
        reject(new Error(`Hook ${hook.id} timed out`));
      }, hook.timeoutMs ?? 2_000);
    });
    const result = await Promise.race([hook.run(payload, controller.signal), timeout]);
    if (!['allow', 'ask', 'deny', 'delegate'].includes(result.decision)) {
      throw new Error(`Hook ${hook.id} returned an invalid decision`);
    }
    return result;
  } catch (error) {
    return { decision: 'deny', reason: asError(error, `Hook ${hook.id} failed`).message };
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abort);
  }
}

function toolDescriptors(value: unknown): readonly McpToolDescriptor[] {
  if (!isRecord(value) || !Array.isArray(value.tools))
    throw new Error('Invalid MCP tools/list result');
  return value.tools.map((tool) => {
    if (!isRecord(tool) || typeof tool.name !== 'string' || tool.name.length === 0) {
      throw new Error('Invalid MCP tool descriptor');
    }
    return tool as unknown as McpToolDescriptor;
  });
}

function inputSchema(value: unknown): JsonObject {
  if (!isRecord(value)) return { type: 'object', additionalProperties: true };
  return value as JsonObject;
}

function normalizeToolResult(value: unknown): {
  text: string;
  data?: JsonValue;
  artifacts?: readonly ToolArtifact[];
} {
  if (!isRecord(value)) return { text: stringify(value) };
  const content = Array.isArray(value.content) ? value.content : [];
  const text = content
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
  const artifacts: ToolArtifact[] = content
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .filter((item) => item.type === 'resource' && typeof item.uri === 'string')
    .map((item) => ({ type: 'mcp-resource', uri: item.uri as string }));
  return {
    text: text || stringify(value),
    ...(isJsonValue(value.structuredContent) ? { data: value.structuredContent } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
  };
}

function safeSegment(name: string): string {
  const value = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!value) throw new Error(`MCP tool name cannot be normalized: ${name}`);
  return /^[a-z]/.test(value) ? value : `tool_${value}`;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function words(value: string): readonly string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

function contributionManifest(
  id: string,
  kind: 'hooks' | 'skills',
  contributions: readonly string[],
  requiredService: string,
): ForgePlugin['manifest'] {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`Invalid plugin id: ${id}`);
  return {
    apiVersion: FORGE_API_VERSION,
    name: pluginName(`forge-${id}`),
    version: '0.1.0',
    runtime: 'trusted',
    entrypoint: './lib/index.js',
    requires: { [requiredService]: '^0.1.0' },
    contributes: { [kind]: contributions },
    permissions: {},
  };
}

function noop(): void {}
