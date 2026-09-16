import {
  FORGE_API_VERSION,
  type ForgePlugin,
  type ThreadId,
  type TurnId,
  pluginName,
  serviceToken,
} from '@forge/kernel-contracts';
import {
  type CollectedModelResponse,
  type JsonObject,
  type LlmProvider,
  type ModelMessage,
  type ModelRequest,
  type ModelToolCall,
  ProviderError,
  collectModelResponse,
  estimateTokens,
  prepareToolRequest,
} from '@forge/llm-core';
import { SESSION_STORE_SERVICE, type SessionStore, projectModelHistory } from '@forge/session-core';
import {
  TOOL_PIPELINE_SERVICE,
  TOOL_REGISTRY_SERVICE,
  type ToolExecutionResult,
  type ToolPipeline,
  type ToolRegistry,
  type ToolRestriction,
} from '@forge/tools-core';

export type AgentMode = 'ask' | 'plan' | 'code' | 'review';
export type AgentRunState = 'completed' | 'cancelled' | 'failed' | 'limit_reached';

export interface AgentBudgets {
  readonly maxIterations: number;
  readonly maxDurationMs: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxToolCalls: number;
  readonly maxToolResultBytes: number;
  readonly maxRetries: number;
  readonly repeatedToolCallLimit: number;
}

export const DEFAULT_AGENT_BUDGETS: AgentBudgets = Object.freeze({
  maxIterations: 24,
  maxDurationMs: 10 * 60_000,
  maxInputTokens: 200_000,
  maxOutputTokens: 32_000,
  maxToolCalls: 100,
  maxToolResultBytes: 256_000,
  maxRetries: 2,
  repeatedToolCallLimit: 3,
});

export interface AgentModeConfiguration {
  readonly mode: AgentMode;
  readonly system: string;
  readonly toolRestriction: ToolRestriction;
}

export const AGENT_MODES: Readonly<Record<AgentMode, AgentModeConfiguration>> = Object.freeze({
  ask: {
    mode: 'ask',
    system: 'Answer from evidence. You may inspect with read-only tools but must not change state.',
    toolRestriction: { readOnly: true, maximumRisk: 'safe' },
  },
  plan: {
    mode: 'plan',
    system:
      'Investigate with read-only tools and finish with an explicit implementation plan. Do not change state.',
    toolRestriction: { readOnly: true, maximumRisk: 'safe' },
  },
  code: {
    mode: 'code',
    system: 'Implement the request, verify the result, and report concrete outcomes.',
    toolRestriction: { maximumRisk: 'destructive' },
  },
  review: {
    mode: 'review',
    system:
      'Review the current code or diff, prioritize actionable findings, and do not modify state.',
    toolRestriction: { readOnly: true, maximumRisk: 'sensitive' },
  },
});

export interface AgentCreateOptions {
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
  readonly provider: LlmProvider;
  readonly model: string;
  readonly mode?: AgentMode;
  readonly budgets?: Partial<AgentBudgets>;
  readonly allowPromptedToolFallback?: boolean;
}

export interface AgentUsage {
  readonly iterations: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly toolCalls: number;
  readonly toolResultBytes: number;
  readonly retries: number;
}

export interface AgentRunResult {
  readonly state: AgentRunState;
  readonly turnId: TurnId;
  readonly answer: string;
  readonly reason?: string;
  readonly usage: AgentUsage;
}

export interface AgentInboxInspection {
  readonly active: boolean;
  readonly queuedFollowUps: number;
  readonly pendingSteering: readonly string[];
}

export interface Agent {
  run(prompt: string): Promise<AgentRunResult>;
  followUp(prompt: string): Promise<AgentRunResult>;
  steer(message: string): void;
  cancel(reason?: string): void;
  inspectInbox(): AgentInboxInspection;
}

export interface AgentFactory {
  readonly id: string;
  create(options: AgentCreateOptions): Agent;
}

export class AgentRegistry {
  readonly #factories = new Map<string, AgentFactory>();

  register(factory: AgentFactory): () => void {
    if (this.#factories.has(factory.id))
      throw new Error(`Agent factory ${factory.id} is registered`);
    this.#factories.set(factory.id, factory);
    return () => {
      if (this.#factories.get(factory.id) === factory) this.#factories.delete(factory.id);
    };
  }

  create(id: string, options: AgentCreateOptions): Agent {
    const factory = this.#factories.get(id);
    if (!factory) throw new Error(`Agent factory ${id} was not found`);
    return factory.create(options);
  }

  list(): readonly string[] {
    return [...this.#factories.keys()].sort();
  }
}

export const AGENT_FACTORY_SERVICE = serviceToken<AgentFactory>('forge.agent-factory', 'multiple');
export const AGENT_REGISTRY_SERVICE = serviceToken<AgentRegistry>('forge.agent-registry');

export interface DefaultAgentRuntimeOptions {
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export class DefaultAgentFactory implements AgentFactory {
  readonly id = 'default';
  readonly #sessions: SessionStore;
  readonly #tools: ToolRegistry;
  readonly #pipeline: ToolPipeline;
  readonly #runtime: DefaultAgentRuntimeOptions;

  constructor(
    sessions: SessionStore,
    tools: ToolRegistry,
    pipeline: ToolPipeline,
    runtime: DefaultAgentRuntimeOptions = {},
  ) {
    this.#sessions = sessions;
    this.#tools = tools;
    this.#pipeline = pipeline;
    this.#runtime = runtime;
  }

  create(options: AgentCreateOptions): Agent {
    return new DefaultAgent(this.#sessions, this.#tools, this.#pipeline, options, this.#runtime);
  }
}

interface ActiveTurn {
  readonly turnId: TurnId;
  readonly controller: AbortController;
  iterationController?: AbortController;
  deadlineReached: boolean;
}

export class DefaultAgent implements Agent {
  readonly #sessions: SessionStore;
  readonly #tools: ToolRegistry;
  readonly #pipeline: ToolPipeline;
  readonly #options: AgentCreateOptions;
  readonly #budgets: AgentBudgets;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #steering: string[] = [];
  #active: ActiveTurn | undefined;
  #tail: Promise<void> = Promise.resolve();
  #queued = 0;

  constructor(
    sessions: SessionStore,
    tools: ToolRegistry,
    pipeline: ToolPipeline,
    options: AgentCreateOptions,
    runtime: DefaultAgentRuntimeOptions = {},
  ) {
    this.#sessions = sessions;
    this.#tools = tools;
    this.#pipeline = pipeline;
    this.#options = options;
    this.#budgets = { ...DEFAULT_AGENT_BUDGETS, ...options.budgets };
    validateBudgets(this.#budgets);
    this.#sleep = runtime.sleep ?? abortableSleep;
  }

  run(prompt: string): Promise<AgentRunResult> {
    if (!prompt.trim()) return Promise.reject(new Error('Agent prompt cannot be empty'));
    this.#queued += 1;
    const result = this.#tail.then(() => this.#executeTurn(prompt));
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.#queued -= 1;
    });
  }

  followUp(prompt: string): Promise<AgentRunResult> {
    return this.run(prompt);
  }

  steer(message: string): void {
    if (!message.trim()) throw new Error('Steering message cannot be empty');
    if (!this.#active) throw new Error('Cannot steer an agent without an active turn');
    this.#steering.push(message);
    this.#active.iterationController?.abort(new Error('agent steered'));
  }

  cancel(reason = 'cancelled by user'): void {
    this.#active?.controller.abort(new Error(reason));
  }

  inspectInbox(): AgentInboxInspection {
    return {
      active: this.#active !== undefined,
      queuedFollowUps: Math.max(0, this.#queued - 1),
      pendingSteering: [...this.#steering],
    };
  }

  async #executeTurn(prompt: string): Promise<AgentRunResult> {
    this.#repeatCounts.clear();
    const turnId = await this.#sessions.startTurn(this.#options.threadId);
    const controller = new AbortController();
    const active: ActiveTurn = { turnId, controller, deadlineReached: false };
    this.#active = active;
    const timer = setTimeout(() => {
      active.deadlineReached = true;
      controller.abort(new Error('turn deadline reached'));
    }, this.#budgets.maxDurationMs);
    const usage: MutableUsage = {
      iterations: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      toolResultBytes: 0,
      retries: 0,
    };
    try {
      await this.#sessions.appendCompletedItem(this.#options.threadId, {
        turnId,
        kind: 'UserMessage',
        payload: { content: prompt },
      });
      return await this.#runLoop(prompt, active, usage);
    } catch (error) {
      if (controller.signal.aborted) {
        const state = active.deadlineReached ? 'limit_reached' : 'cancelled';
        const reason = active.deadlineReached
          ? 'Maximum turn duration reached'
          : errorMessage(controller.signal.reason);
        await this.#recordTerminal(turnId, state, reason);
        return { state, turnId, answer: '', reason, usage: { ...usage } };
      }
      const reason = errorMessage(error);
      await this.#sessions.appendCompletedItem(this.#options.threadId, {
        turnId,
        kind: 'Error',
        payload: { message: reason, code: errorCode(error) },
      });
      await this.#sessions.transitionTurn(this.#options.threadId, turnId, 'failed');
      return { state: 'failed', turnId, answer: '', reason, usage: { ...usage } };
    } finally {
      clearTimeout(timer);
      this.#steering.length = 0;
      if (this.#active === active) this.#active = undefined;
    }
  }

  async #runLoop(prompt: string, active: ActiveTurn, usage: MutableUsage): Promise<AgentRunResult> {
    const mode = AGENT_MODES[this.#options.mode ?? 'code'];
    const capabilities = await this.#options.provider.capabilities(
      this.#options.model,
      active.controller.signal,
    );
    for (let iteration = 1; iteration <= this.#budgets.maxIterations; iteration += 1) {
      throwIfCancelled(active.controller.signal);
      await this.#drainSteering(active.turnId);
      usage.iterations = iteration;
      const snapshot = await this.#sessions.readThread(this.#options.threadId);
      const visibleTools = this.#tools.present({
        query: [prompt, ...this.#steering].join(' '),
        restriction: mode.toolRestriction,
      });
      const canonical: ModelRequest = {
        model: this.#options.model,
        system: mode.system,
        messages: toModelMessages(snapshot),
        tools: visibleTools,
        toolChoice: visibleTools.length > 0 ? 'auto' : 'none',
        maxOutputTokens: Math.min(
          capabilities.maxOutputTokens,
          Math.max(1, this.#budgets.maxOutputTokens - usage.outputTokens),
        ),
      };
      const prepared = prepareToolRequest(canonical, capabilities, {
        ...(this.#options.allowPromptedToolFallback === undefined
          ? {}
          : { allowPromptedFallback: this.#options.allowPromptedToolFallback }),
      });
      const estimatedInput =
        (await this.#options.provider.countTokens(prepared.request, active.controller.signal)) ??
        estimateTokens(prepared.request);
      if (usage.inputTokens + estimatedInput > this.#budgets.maxInputTokens) {
        return this.#limit(active.turnId, usage, 'Maximum input-token budget reached');
      }

      const iterationController = new AbortController();
      active.iterationController = iterationController;
      const signal = AbortSignal.any([active.controller.signal, iterationController.signal]);
      let response: CollectedModelResponse;
      try {
        response = await this.#generateWithRetry(prepared.request, signal, usage);
      } catch (error) {
        if (
          iterationController.signal.aborted &&
          !active.controller.signal.aborted &&
          this.#steering.length > 0
        ) {
          continue;
        }
        throw error;
      } finally {
        delete active.iterationController;
      }

      usage.inputTokens += response.usage?.inputTokens ?? estimatedInput;
      usage.outputTokens += response.usage?.outputTokens ?? Math.ceil(response.text.length / 4);
      const normalized = normalizeFallbackResponse(prepared.selection.level, response);
      await this.#recordModelResponse(active.turnId, normalized);
      if (
        usage.inputTokens > this.#budgets.maxInputTokens ||
        usage.outputTokens > this.#budgets.maxOutputTokens ||
        response.finishReason === 'length'
      ) {
        return this.#limit(active.turnId, usage, 'Model token or output limit reached');
      }
      if (normalized.toolCalls.length === 0) {
        await this.#sessions.transitionTurn(this.#options.threadId, active.turnId, 'completed');
        return {
          state: 'completed',
          turnId: active.turnId,
          answer: normalized.text,
          usage: { ...usage },
        };
      }
      if (usage.toolCalls + normalized.toolCalls.length > this.#budgets.maxToolCalls) {
        return this.#limit(active.turnId, usage, 'Maximum tool-call budget reached');
      }
      usage.toolCalls += normalized.toolCalls.length;
      const results = await this.#pipeline.executeBatch(normalized.toolCalls, {
        workspaceRoot: this.#options.workspaceRoot,
        mode: mode.mode,
        signal: active.controller.signal,
        restriction: mode.toolRestriction,
      });
      const repeated = await this.#recordToolResults(
        active.turnId,
        normalized.toolCalls,
        results,
        usage,
      );
      if (repeated)
        return this.#limit(active.turnId, usage, 'Repeated identical tool loop detected');
      if (usage.toolResultBytes >= this.#budgets.maxToolResultBytes) {
        return this.#limit(active.turnId, usage, 'Maximum tool-result byte budget reached');
      }
    }
    return this.#limit(active.turnId, usage, 'Maximum model iterations reached');
  }

  async #generateWithRetry(
    request: ModelRequest,
    signal: AbortSignal,
    usage: MutableUsage,
  ): Promise<CollectedModelResponse> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await collectModelResponse(this.#options.provider.generate(request, signal));
      } catch (error) {
        if (
          !(error instanceof ProviderError) ||
          !error.retryable ||
          attempt >= this.#budgets.maxRetries ||
          signal.aborted
        ) {
          throw error;
        }
        usage.retries += 1;
        await this.#sleep(Math.min(1_000, 50 * 2 ** attempt), signal);
      }
    }
  }

  async #recordModelResponse(turnId: TurnId, response: CollectedModelResponse): Promise<void> {
    if (response.reasoningSummary) {
      await this.#sessions.appendCompletedItem(this.#options.threadId, {
        turnId,
        kind: 'ReasoningSummary',
        payload: { summary: response.reasoningSummary },
      });
    }
    if (response.text) {
      await this.#sessions.appendCompletedItem(this.#options.threadId, {
        turnId,
        kind: 'AssistantMessage',
        payload: { content: response.text },
      });
    }
    for (const call of response.toolCalls) {
      await this.#sessions.appendCompletedItem(this.#options.threadId, {
        turnId,
        kind: 'ToolCall',
        payload: { callId: call.callId, name: call.name, arguments: call.arguments },
      });
    }
  }

  readonly #repeatCounts = new Map<string, number>();

  async #recordToolResults(
    turnId: TurnId,
    calls: readonly ModelToolCall[],
    results: readonly ToolExecutionResult[],
    usage: MutableUsage,
  ): Promise<boolean> {
    for (const [index, call] of calls.entries()) {
      const result = results[index];
      if (!result) throw new Error(`Tool result missing for ${call.callId}`);
      const remaining = Math.max(0, this.#budgets.maxToolResultBytes - usage.toolResultBytes);
      const text = takeUtf8(result.text, remaining);
      usage.toolResultBytes += Buffer.byteLength(text);
      await this.#sessions.appendCompletedItem(this.#options.threadId, {
        turnId,
        kind: 'ToolResult',
        payload: {
          callId: call.callId,
          output: text || '[Tool result omitted: turn result-byte budget exhausted]',
          isError: !result.ok,
        },
      });
      const signature = stableJson({
        name: call.name,
        arguments: call.arguments,
        result: { ok: result.ok, text, code: result.error?.code ?? null },
      });
      const count = (this.#repeatCounts.get(signature) ?? 0) + 1;
      this.#repeatCounts.set(signature, count);
      if (count >= this.#budgets.repeatedToolCallLimit) return true;
    }
    return false;
  }

  async #drainSteering(turnId: TurnId): Promise<void> {
    while (this.#steering.length > 0) {
      const message = this.#steering.shift();
      if (message) await this.#sessions.steerTurn(this.#options.threadId, turnId, message);
    }
  }

  async #limit(turnId: TurnId, usage: MutableUsage, reason: string): Promise<AgentRunResult> {
    await this.#recordTerminal(turnId, 'limit_reached', reason);
    return { state: 'limit_reached', turnId, answer: '', reason, usage: { ...usage } };
  }

  async #recordTerminal(turnId: TurnId, state: 'cancelled' | 'limit_reached', reason: string) {
    await this.#sessions.appendCompletedItem(this.#options.threadId, {
      turnId,
      kind: 'Warning',
      payload: { message: reason, code: `agent.${state}` },
    });
    await this.#sessions.transitionTurn(this.#options.threadId, turnId, state);
  }
}

interface MutableUsage {
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  toolResultBytes: number;
  retries: number;
}

function toModelMessages(
  snapshot: Awaited<ReturnType<SessionStore['readThread']>>,
): ModelMessage[] {
  return projectModelHistory(snapshot).map((entry): ModelMessage => {
    if (entry.type === 'message') return entry;
    if (entry.type === 'tool_call') {
      return {
        role: 'assistant',
        toolCalls: [
          {
            callId: entry.callId,
            name: entry.name,
            arguments: entry.arguments as JsonObject,
          },
        ],
      };
    }
    return { role: 'tool', callId: entry.callId, content: entry.content };
  });
}

function normalizeFallbackResponse(
  level: ReturnType<typeof prepareToolRequest>['selection']['level'],
  response: CollectedModelResponse,
): CollectedModelResponse {
  if (response.toolCalls.length > 0 || level === 'native' || level === 'none') return response;
  if (level === 'constrained_json') {
    try {
      const parsed = JSON.parse(response.text) as unknown;
      if (isRecord(parsed) && isRecord(parsed.tool) && isToolPayload(parsed.tool)) {
        return {
          ...response,
          text: '',
          toolCalls: [
            {
              callId: `fallback_${hashText(response.text)}`,
              name: parsed.tool.name,
              arguments: parsed.tool.arguments,
            },
          ],
          finishReason: 'tool_calls',
        };
      }
      if (isRecord(parsed) && typeof parsed.final === 'string') {
        return { ...response, text: parsed.final };
      }
    } catch {
      return response;
    }
  }
  if (level === 'prompted_protocol') {
    const line = response.text.split('\n').find((entry) => entry.startsWith('FORGE_TOOL '));
    if (line) {
      try {
        const parsed = JSON.parse(line.slice('FORGE_TOOL '.length)) as unknown;
        if (isToolPayload(parsed)) {
          return {
            ...response,
            text: response.text.replace(line, '').trim(),
            toolCalls: [
              {
                callId: `fallback_${hashText(line)}`,
                name: parsed.name,
                arguments: parsed.arguments,
              },
            ],
            finishReason: 'tool_calls',
          };
        }
      } catch {
        return response;
      }
    }
  }
  return response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToolPayload(value: unknown): value is { name: string; arguments: JsonObject } {
  return isRecord(value) && typeof value.name === 'string' && isRecord(value.arguments);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (const character of text) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function takeUtf8(text: string, budget: number): string {
  let output = '';
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > budget) break;
    output += character;
    bytes += size;
  }
  return output;
}

function validateBudgets(budgets: AgentBudgets): void {
  for (const [name, value] of Object.entries(budgets)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Agent budget ${name} must be a positive integer`);
    }
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  return error instanceof ProviderError ? `provider.${error.code.toLowerCase()}` : 'agent.failed';
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export function createDefaultAgentPlugin(runtime?: DefaultAgentRuntimeOptions): ForgePlugin {
  return {
    manifest: {
      apiVersion: FORGE_API_VERSION,
      name: pluginName('forge-agent-default'),
      version: '0.1.0',
      runtime: 'trusted',
      entrypoint: './lib/index.js',
      requires: {
        [SESSION_STORE_SERVICE.id]: '^0.1.0',
        [TOOL_REGISTRY_SERVICE.id]: '^0.1.0',
        [TOOL_PIPELINE_SERVICE.id]: '^0.1.0',
      },
      provides: [AGENT_FACTORY_SERVICE.id],
      permissions: {},
    },
    setup(context) {
      context.provide(
        AGENT_FACTORY_SERVICE,
        new DefaultAgentFactory(
          context.get(SESSION_STORE_SERVICE),
          context.get(TOOL_REGISTRY_SERVICE),
          context.get(TOOL_PIPELINE_SERVICE),
          runtime,
        ),
      );
    },
  };
}

export function createAgentRegistryPlugin(): ForgePlugin {
  return {
    manifest: {
      apiVersion: FORGE_API_VERSION,
      name: pluginName('forge-agent-registry'),
      version: '0.1.0',
      runtime: 'trusted',
      entrypoint: './lib/index.js',
      requires: { [AGENT_FACTORY_SERVICE.id]: '^0.1.0' },
      provides: [AGENT_REGISTRY_SERVICE.id],
      permissions: {},
    },
    setup(context) {
      const registry = new AgentRegistry();
      for (const factory of context.get(AGENT_FACTORY_SERVICE)) registry.register(factory);
      context.provide(AGENT_REGISTRY_SERVICE, registry);
    },
  };
}
