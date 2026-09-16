import { serviceToken } from '@forge/kernel-contracts';

export type ProviderId = string & { readonly __brand: 'ProviderId' };
export type ToolProtocolLevel = 'native' | 'constrained_json' | 'prompted_protocol' | 'none';
export type StructuredOutputSupport = 'json_schema' | 'json_object' | 'none';
export type TokenCountingSupport = 'exact' | 'estimated' | 'none';

export interface ModelCapabilities {
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly streaming: boolean;
  readonly nativeToolCalls: boolean;
  readonly parallelToolCalls: boolean;
  readonly structuredOutput: StructuredOutputSupport;
  readonly vision: boolean;
  readonly promptCaching: 'automatic' | 'explicit' | 'none';
  readonly tokenCounting: TokenCountingSupport;
  readonly toolResultRole: boolean;
  readonly supportsSystemMessage: boolean;
}

export interface ModelDescriptor {
  readonly id: string;
  readonly providerId: ProviderId;
  readonly displayName: string;
  readonly capabilities: ModelCapabilities;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface ModelToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: JsonObject;
}

export type ModelMessage =
  | { readonly role: 'system' | 'user' | 'assistant'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content?: string;
      readonly toolCalls: readonly ModelToolCall[];
    }
  | { readonly role: 'tool'; readonly callId: string; readonly content: string };

export interface ModelTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export type ToolChoice = 'auto' | 'none' | 'required' | { readonly name: string };
export type OutputConstraint =
  | { readonly type: 'json_object' }
  | { readonly type: 'json_schema'; readonly name: string; readonly schema: JsonObject };

export interface ModelRequest {
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly system?: string;
  readonly tools?: readonly ModelTool[];
  readonly toolChoice?: ToolChoice;
  readonly output?: OutputConstraint;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly stop?: readonly string[];
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
}

export type ModelFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error';
export type ModelEvent =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'reasoning_summary_delta'; readonly text: string }
  | { readonly type: 'tool_call_start'; readonly callId: string; readonly name: string }
  | { readonly type: 'tool_call_arguments_delta'; readonly callId: string; readonly delta: string }
  | {
      readonly type: 'tool_call_end';
      readonly callId: string;
      readonly name: string;
      readonly arguments: JsonObject;
    }
  | { readonly type: 'usage'; readonly usage: ModelUsage }
  | { readonly type: 'completed'; readonly finishReason: ModelFinishReason };

export type ProviderErrorCode =
  | 'AUTHENTICATION'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'MODEL_NOT_FOUND'
  | 'UNSUPPORTED_FEATURE'
  | 'MALFORMED_STREAM'
  | 'HTTP_ERROR'
  | 'PROVIDER_UNAVAILABLE';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(
    code: ProviderErrorCode,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly status?: number;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

export interface LlmProvider {
  readonly id: ProviderId;
  discoverModels(signal?: AbortSignal): Promise<readonly ModelDescriptor[]>;
  capabilities(model: string, signal?: AbortSignal): Promise<ModelCapabilities>;
  countTokens(request: ModelRequest, signal?: AbortSignal): Promise<number | undefined>;
  generate(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
}

export const LLM_PROVIDER_SERVICE = serviceToken<LlmProvider>('forge.llm-provider', 'multiple');
export const LLM_REGISTRY_SERVICE = serviceToken<ProviderRegistry>('forge.llm-registry');

const PROVIDER_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export function providerId(value: string): ProviderId {
  if (!PROVIDER_ID.test(value))
    throw new ProviderError('HTTP_ERROR', `Invalid provider id: ${value}`);
  return value as ProviderId;
}

export class ProviderRegistry {
  readonly #providers = new Map<ProviderId, LlmProvider>();

  register(provider: LlmProvider): () => void {
    if (this.#providers.has(provider.id)) {
      throw new ProviderError('HTTP_ERROR', `Provider ${provider.id} is already registered`);
    }
    this.#providers.set(provider.id, provider);
    return () => {
      if (this.#providers.get(provider.id) === provider) this.#providers.delete(provider.id);
    };
  }

  get(id: string): LlmProvider {
    const provider = this.#providers.get(providerId(id));
    if (!provider)
      throw new ProviderError('PROVIDER_UNAVAILABLE', `Provider ${id} is not registered`);
    return provider;
  }

  listProviders(): readonly LlmProvider[] {
    return [...this.#providers.values()];
  }

  async discoverModels(signal?: AbortSignal): Promise<readonly ModelDescriptor[]> {
    const groups = await Promise.all(
      this.listProviders().map((provider) => provider.discoverModels(signal)),
    );
    return groups
      .flat()
      .sort((left, right) =>
        `${left.providerId}/${left.id}`.localeCompare(`${right.providerId}/${right.id}`),
      );
  }

  async resolveModel(reference: string, signal?: AbortSignal): Promise<ModelDescriptor> {
    const separator = reference.indexOf('/');
    if (separator <= 0) {
      throw new ProviderError('MODEL_NOT_FOUND', 'Model reference must be provider/model');
    }
    const provider = this.get(reference.slice(0, separator));
    const model = reference.slice(separator + 1);
    const descriptor = (await provider.discoverModels(signal)).find((entry) => entry.id === model);
    if (!descriptor) throw new ProviderError('MODEL_NOT_FOUND', `Model ${reference} was not found`);
    return descriptor;
  }
}

export interface ToolProtocolSelection {
  readonly level: ToolProtocolLevel;
  readonly degraded: boolean;
  readonly warning?: string;
}

export function selectToolProtocol(
  capabilities: ModelCapabilities,
  options: { readonly allowPromptedFallback?: boolean } = {},
): ToolProtocolSelection {
  if (capabilities.nativeToolCalls) return { level: 'native', degraded: false };
  if (capabilities.structuredOutput !== 'none') {
    return {
      level: 'constrained_json',
      degraded: true,
      warning: 'Native tool calls unavailable; using constrained JSON tool protocol.',
    };
  }
  if (options.allowPromptedFallback) {
    return {
      level: 'prompted_protocol',
      degraded: true,
      warning: 'Structured output unavailable; using prompted tool protocol.',
    };
  }
  return {
    level: 'none',
    degraded: true,
    warning: 'This model cannot safely use tools with the selected profile.',
  };
}

export interface PreparedToolRequest {
  readonly request: ModelRequest;
  readonly selection: ToolProtocolSelection;
}

export function prepareToolRequest(
  request: ModelRequest,
  capabilities: ModelCapabilities,
  options: { readonly allowPromptedFallback?: boolean } = {},
): PreparedToolRequest {
  if (!request.tools?.length) {
    return { request, selection: { level: 'none', degraded: false } };
  }
  const selection = selectToolProtocol(capabilities, options);
  if (selection.level === 'native') return { request, selection };
  if (selection.level === 'none') {
    throw new ProviderError('UNSUPPORTED_FEATURE', selection.warning ?? 'Tools are unsupported');
  }
  const definitions = request.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  const instruction =
    selection.level === 'constrained_json'
      ? 'Return one JSON object with either {"tool":{"name":string,"arguments":object}} or {"final":string}.'
      : 'When using a tool, output exactly one line: FORGE_TOOL {"name":"...","arguments":{...}}. Otherwise answer normally.';
  const fallbackInstructions = [
    request.system,
    instruction,
    `Available tools: ${JSON.stringify(definitions)}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    selection,
    request: {
      model: request.model,
      messages: capabilities.supportsSystemMessage
        ? request.messages
        : [{ role: 'user', content: fallbackInstructions }, ...request.messages],
      ...(capabilities.supportsSystemMessage ? { system: fallbackInstructions } : {}),
      tools: [],
      toolChoice: 'none',
      ...(request.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: request.maxOutputTokens }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.stop === undefined ? {} : { stop: request.stop }),
      ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
      ...(selection.level === 'constrained_json'
        ? {
            output:
              capabilities.structuredOutput === 'json_schema'
                ? ({
                    type: 'json_schema',
                    name: 'forge_tool_protocol',
                    schema: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        tool: { type: 'object' },
                        final: { type: 'string' },
                      },
                    },
                  } as OutputConstraint)
                : ({ type: 'json_object' } as OutputConstraint),
          }
        : {}),
    },
  };
}

export function assertRequestCapabilities(
  request: ModelRequest,
  capabilities: ModelCapabilities,
): void {
  if (request.system && !capabilities.supportsSystemMessage) {
    throw new ProviderError(
      'UNSUPPORTED_FEATURE',
      'Model profile does not support system messages',
    );
  }
  if (request.tools?.length && !capabilities.nativeToolCalls) {
    throw new ProviderError('UNSUPPORTED_FEATURE', 'Model profile does not support native tools');
  }
  if (
    !capabilities.parallelToolCalls &&
    request.messages.some(
      (message) =>
        message.role === 'assistant' && 'toolCalls' in message && message.toolCalls.length > 1,
    )
  ) {
    throw new ProviderError('UNSUPPORTED_FEATURE', 'Model profile does not support parallel tools');
  }
  if (!capabilities.toolResultRole && request.messages.some((message) => message.role === 'tool')) {
    throw new ProviderError('UNSUPPORTED_FEATURE', 'Model profile does not support tool results');
  }
  if (request.output?.type === 'json_schema' && capabilities.structuredOutput !== 'json_schema') {
    throw new ProviderError('UNSUPPORTED_FEATURE', 'Model profile does not support JSON Schema');
  }
  if (request.output?.type === 'json_object' && capabilities.structuredOutput === 'none') {
    throw new ProviderError('UNSUPPORTED_FEATURE', 'Model profile does not support JSON output');
  }
}

export interface CollectedModelResponse {
  readonly text: string;
  readonly reasoningSummary: string;
  readonly toolCalls: readonly ModelToolCall[];
  readonly usage?: ModelUsage;
  readonly finishReason: ModelFinishReason;
}

export async function collectModelResponse(
  events: AsyncIterable<ModelEvent>,
): Promise<CollectedModelResponse> {
  let text = '';
  let reasoningSummary = '';
  let usage: ModelUsage | undefined;
  let finishReason: ModelFinishReason | undefined;
  const active = new Map<string, { name: string; arguments: string }>();
  const toolCalls: ModelToolCall[] = [];
  for await (const event of events) {
    switch (event.type) {
      case 'text_delta':
        text += event.text;
        break;
      case 'reasoning_summary_delta':
        reasoningSummary += event.text;
        break;
      case 'tool_call_start':
        if (active.has(event.callId)) malformed(`Tool call ${event.callId} started twice`);
        active.set(event.callId, { name: event.name, arguments: '' });
        break;
      case 'tool_call_arguments_delta': {
        const call = active.get(event.callId);
        if (!call) malformed(`Arguments arrived before tool call ${event.callId} started`);
        call.arguments += event.delta;
        break;
      }
      case 'tool_call_end': {
        const call = active.get(event.callId);
        if (!call) malformed(`Tool call ${event.callId} ended before it started`);
        if (call.name !== event.name) malformed(`Tool call ${event.callId} changed names`);
        let reconstructed: unknown;
        try {
          reconstructed = JSON.parse(call.arguments || '{}');
        } catch (error) {
          throw new ProviderError(
            'MALFORMED_STREAM',
            `Tool call ${event.callId} has invalid JSON`,
            {
              cause: error,
            },
          );
        }
        if (!isJsonObject(reconstructed))
          malformed(`Tool call ${event.callId} arguments are not an object`);
        if (JSON.stringify(reconstructed) !== JSON.stringify(event.arguments)) {
          malformed(`Tool call ${event.callId} arguments do not match streamed fragments`);
        }
        toolCalls.push({ callId: event.callId, name: event.name, arguments: event.arguments });
        active.delete(event.callId);
        break;
      }
      case 'usage':
        usage = event.usage;
        break;
      case 'completed':
        if (finishReason !== undefined) malformed('Provider emitted completion more than once');
        finishReason = event.finishReason;
        break;
    }
  }
  if (active.size > 0) malformed('Provider stream ended with incomplete tool calls');
  if (finishReason === undefined) malformed('Provider stream ended without completion');
  return {
    text,
    reasoningSummary,
    toolCalls,
    ...(usage === undefined ? {} : { usage }),
    finishReason,
  };
}

function malformed(message: string): never {
  throw new ProviderError('MALFORMED_STREAM', message);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function estimateTokens(request: ModelRequest): number {
  const text = JSON.stringify(request);
  return Math.max(1, Math.ceil(text.length / 4));
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ProviderError('CANCELLED', 'Model request was cancelled', { cause: signal.reason });
  }
}

export interface FakeProviderResponse {
  readonly events: readonly ModelEvent[];
  readonly delayMs?: number;
  readonly error?: ProviderError;
}

export class FakeLlmProvider implements LlmProvider {
  readonly id: ProviderId;
  readonly requests: ModelRequest[] = [];
  readonly #models: readonly ModelDescriptor[];
  readonly #responses: FakeProviderResponse[];

  constructor(
    id: string,
    models: readonly ModelDescriptor[],
    responses: readonly FakeProviderResponse[],
  ) {
    this.id = providerId(id);
    this.#models = models;
    this.#responses = [...responses];
  }

  async discoverModels(signal?: AbortSignal): Promise<readonly ModelDescriptor[]> {
    throwIfAborted(signal);
    return this.#models;
  }

  async capabilities(model: string, signal?: AbortSignal): Promise<ModelCapabilities> {
    throwIfAborted(signal);
    const descriptor = this.#models.find((entry) => entry.id === model);
    if (!descriptor) throw new ProviderError('MODEL_NOT_FOUND', `Model ${model} was not found`);
    return descriptor.capabilities;
  }

  async countTokens(request: ModelRequest, signal?: AbortSignal): Promise<number> {
    throwIfAborted(signal);
    return estimateTokens(request);
  }

  async *generate(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    throwIfAborted(signal);
    this.requests.push(structuredClone(request));
    const response = this.#responses.shift();
    if (!response) throw new ProviderError('PROVIDER_UNAVAILABLE', 'Fake provider has no response');
    if (response.error) throw response.error;
    for (const event of response.events) {
      if (response.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, response.delayMs);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new ProviderError('CANCELLED', 'Model request was cancelled'));
            },
            { once: true },
          );
        });
      }
      throwIfAborted(signal);
      yield event;
    }
  }
}

export const DEFAULT_CAPABILITIES: ModelCapabilities = Object.freeze({
  contextWindow: 32_768,
  maxOutputTokens: 8_192,
  streaming: true,
  nativeToolCalls: false,
  parallelToolCalls: false,
  structuredOutput: 'none',
  vision: false,
  promptCaching: 'none',
  tokenCounting: 'estimated',
  toolResultRole: true,
  supportsSystemMessage: true,
});

export * from './streaming.js';
