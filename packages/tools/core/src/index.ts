import {
  FORGE_API_VERSION,
  type ForgePlugin,
  pluginName,
  serviceToken,
} from '@forge/kernel-contracts';
import type { JsonObject, JsonValue, ModelTool } from '@forge/llm-core';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

export type ToolRisk = 'safe' | 'sensitive' | 'destructive';
export type ToolOrigin = 'official-plugin' | 'third-party-plugin' | 'mcp';
export type ToolVisibility = 'always' | 'lazy';

export interface ToolDefinition {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  readonly capabilities: readonly string[];
  readonly risk: ToolRisk;
  readonly readOnly: boolean;
  readonly idempotent: boolean;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxOutputLines?: number;
  readonly origin: ToolOrigin;
  readonly visibility?: ToolVisibility;
  readonly keywords?: readonly string[];
}

export interface ToolArtifact {
  readonly type: string;
  readonly uri?: string;
  readonly path?: string;
  readonly mimeType?: string;
  readonly sizeBytes?: number;
}

export interface ToolOutput {
  readonly text: string;
  readonly data?: JsonValue;
  readonly artifacts?: readonly ToolArtifact[];
}

export interface ToolExecutionContext {
  readonly callId: string;
  readonly signal: AbortSignal;
  readonly workspaceRoot: string;
  readonly mode: string;
}

export interface Tool {
  readonly definition: ToolDefinition;
  execute(arguments_: JsonObject, context: ToolExecutionContext): Promise<ToolOutput>;
}

export interface ToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: JsonObject;
}

export type ToolPolicyDecision =
  | { readonly decision: 'allow' }
  | { readonly decision: 'ask'; readonly reason: string }
  | { readonly decision: 'deny'; readonly reason: string };

export interface GuardedToolCall extends ToolCall {
  readonly definition: ToolDefinition;
  readonly workspaceRoot: string;
  readonly mode: string;
}

export interface ToolGuard {
  evaluate(
    call: GuardedToolCall,
    signal: AbortSignal,
  ): ToolPolicyDecision | Promise<ToolPolicyDecision>;
}

export type ToolErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_ARGUMENTS'
  | 'DENIED'
  | 'APPROVAL_REQUIRED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'EXECUTION_FAILED'
  | 'INVALID_RESULT'
  | 'PIPELINE_FAILED';

export interface ToolError {
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly validationErrors?: readonly string[];
}

export interface ToolTiming {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
}

export interface ToolExecutionResult {
  readonly callId: string;
  readonly name: string;
  readonly version?: string;
  readonly origin?: ToolOrigin;
  readonly arguments: JsonObject;
  readonly ok: boolean;
  readonly text: string;
  readonly data?: JsonValue;
  readonly artifacts: readonly ToolArtifact[];
  readonly timing: ToolTiming;
  readonly truncated: boolean;
  readonly originalBytes: number;
  readonly error?: ToolError;
  readonly policy?: ToolPolicyDecision;
}

export interface ToolRestriction {
  readonly names?: readonly string[];
  readonly readOnly?: boolean;
  readonly maximumRisk?: ToolRisk;
}

export interface ToolDiscoveryOptions {
  readonly query?: string;
  readonly includeLazy?: boolean;
  readonly restriction?: ToolRestriction;
}

export interface RegisteredTool {
  readonly tool: Tool;
  readonly validateInput: ValidateFunction;
  readonly validateOutput?: ValidateFunction;
}

const TOOL_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const RISK_RANK: Readonly<Record<ToolRisk, number>> = { safe: 0, sensitive: 1, destructive: 2 };

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();
  readonly #ajv = new Ajv2020({ allErrors: true, strict: false });

  register(tool: Tool): () => void {
    validateDefinition(tool.definition);
    if (this.#tools.has(tool.definition.name)) {
      throw new Error(`Tool ${tool.definition.name} is already registered`);
    }
    const registered: RegisteredTool = {
      tool,
      validateInput: this.#ajv.compile(tool.definition.inputSchema),
      ...(tool.definition.outputSchema
        ? { validateOutput: this.#ajv.compile(tool.definition.outputSchema) }
        : {}),
    };
    this.#tools.set(tool.definition.name, registered);
    return () => {
      if (this.#tools.get(tool.definition.name) === registered) {
        this.#tools.delete(tool.definition.name);
      }
    };
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name)?.tool;
  }

  inspect(name: string): RegisteredTool | undefined {
    return this.#tools.get(name);
  }

  discover(options: ToolDiscoveryOptions = {}): readonly ToolDefinition[] {
    const terms = (options.query ?? '')
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter(Boolean);
    return [...this.#tools.values()]
      .map(({ tool }) => tool.definition)
      .filter((definition) => allowedByRestriction(definition, options.restriction))
      .filter((definition) => {
        if ((definition.visibility ?? 'always') === 'always' || options.includeLazy) return true;
        if (terms.length === 0) return false;
        const haystack = [definition.name, definition.description, ...(definition.keywords ?? [])]
          .join(' ')
          .toLowerCase();
        return terms.some((term) => haystack.includes(term));
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  present(options?: ToolDiscoveryOptions): readonly ModelTool[] {
    return this.discover(options).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }
}

function validateDefinition(definition: ToolDefinition): void {
  if (!TOOL_NAME.test(definition.name)) throw new Error(`Invalid tool name: ${definition.name}`);
  if (!definition.version || !definition.description) {
    throw new Error(`Tool ${definition.name} requires a version and description`);
  }
  if (!Number.isSafeInteger(definition.timeoutMs) || definition.timeoutMs <= 0) {
    throw new Error(`Tool ${definition.name} requires a positive timeout`);
  }
  if (!Number.isSafeInteger(definition.maxOutputBytes) || definition.maxOutputBytes <= 0) {
    throw new Error(`Tool ${definition.name} requires a positive output limit`);
  }
}

function allowedByRestriction(definition: ToolDefinition, restriction?: ToolRestriction): boolean {
  if (!restriction) return true;
  if (restriction.names && !restriction.names.includes(definition.name)) return false;
  if (restriction.readOnly && !definition.readOnly) return false;
  if (restriction.maximumRisk && RISK_RANK[definition.risk] > RISK_RANK[restriction.maximumRisk]) {
    return false;
  }
  return true;
}

export interface ToolPipelineHooks {
  readonly preExecute?: readonly ((
    call: GuardedToolCall,
  ) => GuardedToolCall | Promise<GuardedToolCall>)[];
  readonly wrappers?: readonly ((
    call: GuardedToolCall,
    next: () => Promise<ToolOutput>,
  ) => Promise<ToolOutput>)[];
  readonly postExecute?: readonly ((
    call: GuardedToolCall,
    result: ToolExecutionResult,
  ) => void | Promise<void>)[];
  readonly recordResult?: (call: ToolCall, result: ToolExecutionResult) => void | Promise<void>;
  readonly clock?: () => number;
  readonly timestamp?: () => string;
}

export interface ExecuteToolOptions {
  readonly workspaceRoot: string;
  readonly mode: string;
  readonly signal?: AbortSignal;
  readonly restriction?: ToolRestriction;
}

export class ToolPipeline {
  readonly #registry: ToolRegistry;
  readonly #guard: ToolGuard;
  readonly #hooks: ToolPipelineHooks;

  constructor(registry: ToolRegistry, guard: ToolGuard, hooks: ToolPipelineHooks = {}) {
    this.#registry = registry;
    this.#guard = guard;
    this.#hooks = hooks;
  }

  async execute(call: ToolCall, options: ExecuteToolOptions): Promise<ToolExecutionResult> {
    const clock = this.#hooks.clock ?? (() => performance.now());
    const timestamp = this.#hooks.timestamp ?? (() => new Date().toISOString());
    const started = clock();
    const startedAt = timestamp();
    let guarded: GuardedToolCall | undefined;
    let result: ToolExecutionResult;
    try {
      const registered = this.#registry.inspect(call.name);
      if (!registered || !allowedByRestriction(registered.tool.definition, options.restriction)) {
        result = failure(
          call,
          'NOT_FOUND',
          `Tool ${call.name} is not available`,
          false,
          started,
          startedAt,
          clock,
          timestamp,
        );
      } else {
        const validation = validationErrors(registered.validateInput, call.arguments);
        if (validation) {
          result = failure(
            call,
            'INVALID_ARGUMENTS',
            'Tool arguments did not match the schema',
            true,
            started,
            startedAt,
            clock,
            timestamp,
            validation,
          );
        } else {
          guarded = {
            ...call,
            definition: registered.tool.definition,
            workspaceRoot: options.workspaceRoot,
            mode: options.mode,
          };
          for (const hook of this.#hooks.preExecute ?? []) {
            const prepared = await hook(guarded);
            if (prepared.callId !== call.callId || prepared.name !== call.name) {
              throw new Error('Pre-execute hooks cannot change tool identity');
            }
            guarded = prepared;
          }
          const postHookValidation = validationErrors(registered.validateInput, guarded.arguments);
          if (postHookValidation) {
            result = failure(
              guarded,
              'INVALID_ARGUMENTS',
              'Pre-execute arguments did not match the schema',
              true,
              started,
              startedAt,
              clock,
              timestamp,
              postHookValidation,
              registered.tool.definition,
            );
          } else {
            result = await this.#executeGuarded(
              registered,
              guarded,
              options,
              started,
              startedAt,
              clock,
              timestamp,
            );
          }
        }
      }
    } catch (error) {
      result = failure(
        call,
        'PIPELINE_FAILED',
        errorMessage(error),
        false,
        started,
        startedAt,
        clock,
        timestamp,
        undefined,
        guarded?.definition,
      );
    }

    if (guarded) {
      for (const hook of this.#hooks.postExecute ?? []) {
        try {
          await hook(guarded, result);
        } catch (error) {
          result = failure(
            guarded,
            'PIPELINE_FAILED',
            `Post-execute hook failed: ${errorMessage(error)}`,
            false,
            started,
            startedAt,
            clock,
            timestamp,
            undefined,
            guarded.definition,
          );
          break;
        }
      }
    }
    await this.#hooks.recordResult?.(guarded ?? call, result);
    return Object.freeze(result);
  }

  async executeBatch(
    calls: readonly ToolCall[],
    options: ExecuteToolOptions,
  ): Promise<readonly ToolExecutionResult[]> {
    const results: ToolExecutionResult[] = [];
    let parallel: { readonly index: number; readonly promise: Promise<ToolExecutionResult> }[] = [];
    const flush = async () => {
      const completed = await Promise.all(parallel.map(({ promise }) => promise));
      for (const [offset, item] of parallel.entries()) {
        const slot = item?.index;
        if (slot !== undefined && completed[offset]) results[slot] = completed[offset];
      }
      parallel = [];
    };
    for (const [index, call] of calls.entries()) {
      const definition = this.#registry.get(call.name)?.definition;
      if (definition?.readOnly) {
        parallel.push({ index, promise: this.execute(call, options) });
      } else {
        await flush();
        results[index] = await this.execute(call, options);
      }
    }
    await flush();
    return results;
  }

  async #executeGuarded(
    registered: RegisteredTool,
    call: GuardedToolCall,
    options: ExecuteToolOptions,
    started: number,
    startedAt: string,
    clock: () => number,
    timestamp: () => string,
  ): Promise<ToolExecutionResult> {
    if (options.signal?.aborted) {
      return failure(
        call,
        'CANCELLED',
        'Tool call was cancelled',
        false,
        started,
        startedAt,
        clock,
        timestamp,
        undefined,
        call.definition,
      );
    }
    const policy = await this.#guard.evaluate(call, options.signal ?? new AbortController().signal);
    if (policy.decision !== 'allow') {
      return failure(
        call,
        policy.decision === 'ask' ? 'APPROVAL_REQUIRED' : 'DENIED',
        policy.reason,
        false,
        started,
        startedAt,
        clock,
        timestamp,
        undefined,
        call.definition,
        policy,
      );
    }

    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
        once: true,
      });
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('tool timeout'));
      }, call.definition.timeoutMs);
    });
    try {
      const base = () =>
        registered.tool.execute(call.arguments, {
          callId: call.callId,
          signal: controller.signal,
          workspaceRoot: call.workspaceRoot,
          mode: call.mode,
        });
      const wrapped = (this.#hooks.wrappers ?? []).reduceRight<() => Promise<ToolOutput>>(
        (next, wrapper) => () => wrapper(call, next),
        base,
      );
      const output = await Promise.race([wrapped(), abortPromise]);
      const outputErrors = registered.validateOutput
        ? validationErrors(registered.validateOutput, output.data)
        : undefined;
      if (outputErrors) {
        return failure(
          call,
          'INVALID_RESULT',
          'Tool result did not match the output schema',
          false,
          started,
          startedAt,
          clock,
          timestamp,
          outputErrors,
          call.definition,
          policy,
        );
      }
      return success(call, output, started, startedAt, clock, timestamp, policy);
    } catch (error) {
      const cancelled = options.signal?.aborted ?? false;
      return failure(
        call,
        timedOut ? 'TIMEOUT' : cancelled ? 'CANCELLED' : 'EXECUTION_FAILED',
        errorMessage(error),
        !timedOut && !cancelled && call.definition.idempotent,
        started,
        startedAt,
        clock,
        timestamp,
        undefined,
        call.definition,
        policy,
      );
    } finally {
      clearTimeout(timeoutTimer);
      options.signal?.removeEventListener('abort', abort);
    }
  }
}

function validationErrors(
  validate: ValidateFunction,
  value: unknown,
): readonly string[] | undefined {
  if (validate(value)) return undefined;
  return (validate.errors ?? []).map(formatValidationError);
}

function formatValidationError(error: ErrorObject): string {
  return `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`;
}

function success(
  call: GuardedToolCall,
  output: ToolOutput,
  started: number,
  startedAt: string,
  clock: () => number,
  timestamp: () => string,
  policy: ToolPolicyDecision,
): ToolExecutionResult {
  const normalized = truncateOutput(
    output.text,
    call.definition.maxOutputBytes,
    call.definition.maxOutputLines,
  );
  return {
    callId: call.callId,
    name: call.name,
    version: call.definition.version,
    origin: call.definition.origin,
    arguments: call.arguments,
    ok: true,
    text: normalized.text,
    ...(output.data === undefined ? {} : { data: output.data }),
    artifacts: output.artifacts ?? [],
    timing: timing(started, startedAt, clock, timestamp),
    truncated: normalized.truncated,
    originalBytes: normalized.originalBytes,
    policy,
  };
}

function failure(
  call: ToolCall,
  code: ToolErrorCode,
  message: string,
  retryable: boolean,
  started: number,
  startedAt: string,
  clock: () => number,
  timestamp: () => string,
  errors?: readonly string[],
  definition?: ToolDefinition,
  policy?: ToolPolicyDecision,
): ToolExecutionResult {
  return {
    callId: call.callId,
    name: call.name,
    ...(definition ? { version: definition.version, origin: definition.origin } : {}),
    arguments: call.arguments,
    ok: false,
    text: message,
    artifacts: [],
    timing: timing(started, startedAt, clock, timestamp),
    truncated: false,
    originalBytes: Buffer.byteLength(message),
    error: {
      code,
      message,
      retryable,
      ...(errors ? { validationErrors: errors } : {}),
    },
    ...(policy ? { policy } : {}),
  };
}

function timing(
  started: number,
  startedAt: string,
  clock: () => number,
  timestamp: () => string,
): ToolTiming {
  return {
    startedAt,
    finishedAt: timestamp(),
    durationMs: Math.max(0, clock() - started),
  };
}

function truncateOutput(text: string, maxBytes: number, maxLines?: number) {
  const originalBytes = Buffer.byteLength(text);
  const lines = text.split('\n');
  const lineLimited = maxLines !== undefined && lines.length > maxLines;
  let candidate = lineLimited
    ? `${lines.slice(0, Math.ceil(maxLines / 2)).join('\n')}\n… output truncated …\n${lines.slice(-Math.floor(maxLines / 2)).join('\n')}`
    : text;
  if (Buffer.byteLength(candidate) > maxBytes) {
    const marker = '\n… output truncated …\n';
    const markerBytes = Buffer.byteLength(marker);
    if (markerBytes >= maxBytes) candidate = takeUtf8Start(candidate, maxBytes);
    else {
      const budget = maxBytes - markerBytes;
      candidate = `${takeUtf8Start(candidate, Math.ceil(budget / 2))}${marker}${takeUtf8End(candidate, Math.floor(budget / 2))}`;
    }
  }
  return { text: candidate, truncated: lineLimited || originalBytes > maxBytes, originalBytes };
}

function takeUtf8Start(text: string, budget: number): string {
  let result = '';
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > budget) break;
    result += character;
    bytes += size;
  }
  return result;
}

function takeUtf8End(text: string, budget: number): string {
  let result = '';
  let bytes = 0;
  for (const character of Array.from(text).reverse()) {
    const size = Buffer.byteLength(character);
    if (bytes + size > budget) break;
    result = character + result;
    bytes += size;
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const TOOL_REGISTRY_SERVICE = serviceToken<ToolRegistry>('forge.tool-registry');
export const TOOL_PIPELINE_SERVICE = serviceToken<ToolPipeline>('forge.tool-pipeline');

export function createToolRuntimePlugin(
  tools: readonly Tool[],
  guard: ToolGuard,
  hooks?: ToolPipelineHooks,
): ForgePlugin {
  return {
    manifest: {
      apiVersion: FORGE_API_VERSION,
      name: pluginName('forge-tool-runtime'),
      version: '0.1.0',
      runtime: 'trusted',
      entrypoint: './lib/index.js',
      provides: [TOOL_REGISTRY_SERVICE.id, TOOL_PIPELINE_SERVICE.id],
      permissions: {},
    },
    setup(context) {
      const registry = new ToolRegistry();
      for (const tool of tools) registry.register(tool);
      context.provide(TOOL_REGISTRY_SERVICE, registry);
      context.provide(TOOL_PIPELINE_SERVICE, new ToolPipeline(registry, guard, hooks));
    },
  };
}
