import {
  DEFAULT_CAPABILITIES,
  LLM_PROVIDER_SERVICE,
  type JsonObject,
  type JsonValue,
  type LlmProvider,
  type ModelCapabilities,
  type ModelDescriptor,
  type ModelEvent,
  type ModelMessage,
  type ModelRequest,
  type ModelTool,
  ProviderError,
  assertRequestCapabilities,
  estimateTokens,
  isRecord,
  mapHttpError,
  mapTransportError,
  parseJsonRecord,
  providerId,
  readSseData,
  throwIfAborted,
  timedSignal,
} from '@forge/llm-core';
import { FORGE_API_VERSION, type ForgePlugin, pluginName } from '@forge/kernel-contracts';

export interface OpenAiCompatibleOptions {
  readonly id?: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly models?: readonly {
    readonly id: string;
    readonly displayName?: string;
    readonly capabilities?: Partial<ModelCapabilities>;
  }[];
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

interface ActiveToolCall {
  callId: string;
  name: string;
  arguments: string;
  started: boolean;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id;
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #models: OpenAiCompatibleOptions['models'];
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAiCompatibleOptions) {
    this.id = providerId(options.id ?? 'openai-compatible');
    this.#baseUrl = options.baseUrl.replace(/\/$/, '');
    this.#apiKey = options.apiKey;
    this.#headers = options.headers ?? {};
    this.#models = options.models;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async discoverModels(signal?: AbortSignal): Promise<readonly ModelDescriptor[]> {
    throwIfAborted(signal);
    if (this.#models) return this.#models.map((model) => this.#descriptor(model));
    const timing = timedSignal(signal, this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}/models`, {
        headers: this.#requestHeaders(),
        signal: timing.signal,
      });
      if (!response.ok) throw mapHttpError(response.status, this.id);
      const payload = (await response.json()) as unknown;
      if (!isRecord(payload) || !Array.isArray(payload.data)) malformed('models response');
      return payload.data.map((entry) => {
        if (!isRecord(entry) || typeof entry.id !== 'string') malformed('model descriptor');
        return this.#descriptor({ id: entry.id });
      });
    } catch (error) {
      throw mapTransportError(error, this.id, timing, signal);
    } finally {
      timing.dispose();
    }
  }

  async capabilities(model: string, signal?: AbortSignal): Promise<ModelCapabilities> {
    throwIfAborted(signal);
    const configured = this.#models?.find((entry) => entry.id === model);
    return this.#capabilities(configured?.capabilities);
  }

  async countTokens(request: ModelRequest, signal?: AbortSignal): Promise<number> {
    throwIfAborted(signal);
    return estimateTokens(request);
  }

  async *generate(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    throwIfAborted(signal);
    const capabilities = await this.capabilities(request.model, signal);
    assertRequestCapabilities(request, capabilities);
    const timing = timedSignal(signal, this.#timeoutMs);
    const tools = new Map<number, ActiveToolCall>();
    let finishReason: string | undefined;
    try {
      const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.#requestHeaders(),
        body: JSON.stringify(toOpenAiRequest(request)),
        signal: timing.signal,
      });
      if (!response.ok) throw mapHttpError(response.status, this.id);
      for await (const data of readSseData(response.body, timing.signal)) {
        if (data === '[DONE]') break;
        const chunk = parseJsonRecord(data, this.id);
        if (!isRecord(chunk)) malformed('stream chunk');
        const usage = parseUsage(chunk.usage);
        if (usage) yield { type: 'usage', usage };
        const choices = chunk.choices;
        if (!Array.isArray(choices) || choices.length === 0) continue;
        const choice = choices[0];
        if (!isRecord(choice)) malformed('choice');
        if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (!isRecord(delta)) continue;
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          yield { type: 'text_delta', text: delta.content };
        }
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          yield { type: 'reasoning_summary_delta', text: reasoning };
        }
        if (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls)) {
          malformed('tool_calls delta');
        }
        for (const fragment of (delta.tool_calls as unknown[] | undefined) ?? []) {
          if (!isRecord(fragment) || !Number.isSafeInteger(fragment.index)) {
            malformed('tool call fragment');
          }
          const index = fragment.index as number;
          let call = tools.get(index);
          if (!call) {
            call = {
              callId: typeof fragment.id === 'string' ? fragment.id : `call_${index}`,
              name: '',
              arguments: '',
              started: false,
            };
            tools.set(index, call);
          }
          const fn = isRecord(fragment.function) ? fragment.function : {};
          if (typeof fragment.id === 'string') call.callId = fragment.id;
          if (typeof fn.name === 'string') call.name += fn.name;
          if (!call.started && call.name) {
            call.started = true;
            yield { type: 'tool_call_start', callId: call.callId, name: call.name };
          }
          if (typeof fn.arguments === 'string') {
            if (!call.started) malformed('tool arguments arrived before tool name');
            call.arguments += fn.arguments;
            yield {
              type: 'tool_call_arguments_delta',
              callId: call.callId,
              delta: fn.arguments,
            };
          }
        }
      }
      for (const call of [...tools.values()]) {
        if (!call.started) malformed('tool call has no name');
        const args = parseJsonRecord(call.arguments || '{}', `tool call ${call.callId}`);
        if (!isRecord(args)) malformed(`tool call ${call.callId} arguments`);
        yield {
          type: 'tool_call_end',
          callId: call.callId,
          name: call.name,
          arguments: args as JsonObject,
        };
      }
      yield { type: 'completed', finishReason: mapFinishReason(finishReason, tools.size > 0) };
    } catch (error) {
      throw mapTransportError(error, this.id, timing, signal);
    } finally {
      timing.dispose();
    }
  }

  #requestHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
      ...this.#headers,
    };
  }

  #capabilities(overrides?: Partial<ModelCapabilities>): ModelCapabilities {
    return {
      ...DEFAULT_CAPABILITIES,
      nativeToolCalls: true,
      parallelToolCalls: true,
      structuredOutput: 'json_schema',
      ...overrides,
    };
  }

  #descriptor(model: NonNullable<OpenAiCompatibleOptions['models']>[number]): ModelDescriptor {
    return {
      id: model.id,
      providerId: this.id,
      displayName: model.displayName ?? model.id,
      capabilities: this.#capabilities(model.capabilities),
    };
  }
}

function toOpenAiRequest(request: ModelRequest): JsonObject {
  const messages = [
    ...(request.system ? [{ role: 'system', content: request.system }] : []),
    ...request.messages.map(toOpenAiMessage),
  ];
  return {
    model: request.model,
    stream: true,
    stream_options: { include_usage: true },
    messages,
    ...(request.tools?.length ? { tools: request.tools.map(toOpenAiTool) } : {}),
    ...(request.toolChoice ? { tool_choice: toOpenAiToolChoice(request.toolChoice) } : {}),
    ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.stop ? { stop: request.stop } : {}),
    ...(request.output ? { response_format: toOpenAiOutput(request.output) } : {}),
  } as JsonObject;
}

function toOpenAiMessage(message: ModelMessage): JsonObject {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.callId, content: message.content };
  }
  if ('toolCalls' in message) {
    return {
      role: 'assistant',
      content: message.content ?? null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.callId,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function toOpenAiTool(tool: ModelTool): JsonObject {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  };
}

function toOpenAiToolChoice(choice: NonNullable<ModelRequest['toolChoice']>): JsonValue {
  return typeof choice === 'string'
    ? choice
    : { type: 'function', function: { name: choice.name } };
}

function toOpenAiOutput(output: NonNullable<ModelRequest['output']>): JsonObject {
  return output.type === 'json_object'
    ? { type: 'json_object' }
    : { type: 'json_schema', json_schema: { name: output.name, schema: output.schema } };
}

function parseUsage(value: unknown) {
  if (!isRecord(value)) return undefined;
  if (typeof value.prompt_tokens !== 'number' || typeof value.completion_tokens !== 'number') {
    malformed('usage');
  }
  return {
    inputTokens: value.prompt_tokens,
    outputTokens: value.completion_tokens,
    ...(typeof value.prompt_tokens_details === 'object' &&
    value.prompt_tokens_details !== null &&
    'cached_tokens' in value.prompt_tokens_details &&
    typeof value.prompt_tokens_details.cached_tokens === 'number'
      ? { cachedInputTokens: value.prompt_tokens_details.cached_tokens }
      : {}),
  };
}

function mapFinishReason(reason: string | undefined, hasTools: boolean) {
  if (hasTools || reason === 'tool_calls') return 'tool_calls' as const;
  if (reason === 'length') return 'length' as const;
  if (reason === 'content_filter') return 'content_filter' as const;
  return 'stop' as const;
}

function malformed(part: string): never {
  throw new ProviderError('MALFORMED_STREAM', `Malformed OpenAI-compatible ${part}`);
}

export function createOpenAiCompatiblePlugin(options: OpenAiCompatibleOptions): ForgePlugin {
  return {
    manifest: {
      apiVersion: FORGE_API_VERSION,
      name: pluginName('forge-provider-openai-compatible'),
      version: '0.1.0',
      runtime: 'trusted',
      entrypoint: './lib/index.js',
      provides: [LLM_PROVIDER_SERVICE.id],
      permissions: { network: [options.baseUrl] },
    },
    setup(context) {
      context.provide(LLM_PROVIDER_SERVICE, new OpenAiCompatibleProvider(options));
    },
  };
}
