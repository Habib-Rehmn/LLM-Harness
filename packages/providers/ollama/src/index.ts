import {
  DEFAULT_CAPABILITIES,
  LLM_PROVIDER_SERVICE,
  type JsonObject,
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
  readUtf8Lines,
  throwIfAborted,
  timedSignal,
} from '@forge/llm-core';
import { FORGE_API_VERSION, type ForgePlugin, pluginName } from '@forge/kernel-contracts';

export interface OllamaOptions {
  readonly id?: string;
  readonly baseUrl?: string;
  readonly profiles?: Readonly<Record<string, Partial<ModelCapabilities>>>;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

export class OllamaProvider implements LlmProvider {
  readonly id;
  readonly #baseUrl: string;
  readonly #profiles: Readonly<Record<string, Partial<ModelCapabilities>>>;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: OllamaOptions = {}) {
    this.id = providerId(options.id ?? 'ollama');
    this.#baseUrl = (options.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    this.#profiles = options.profiles ?? {};
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async discoverModels(signal?: AbortSignal): Promise<readonly ModelDescriptor[]> {
    const timing = timedSignal(signal, this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}/api/tags`, { signal: timing.signal });
      if (!response.ok) throw mapHttpError(response.status, this.id);
      const payload = (await response.json()) as unknown;
      if (!isRecord(payload) || !Array.isArray(payload.models)) malformed('tags response');
      return payload.models.map((model) => {
        if (!isRecord(model) || typeof model.name !== 'string') malformed('model descriptor');
        return {
          id: model.name,
          providerId: this.id,
          displayName: model.name,
          capabilities: this.#capabilities(model.name),
          ...(typeof model.modified_at === 'string'
            ? { metadata: { modifiedAt: model.modified_at } }
            : {}),
        };
      });
    } catch (error) {
      throw mapTransportError(error, this.id, timing, signal);
    } finally {
      timing.dispose();
    }
  }

  async capabilities(model: string, signal?: AbortSignal): Promise<ModelCapabilities> {
    throwIfAborted(signal);
    return this.#capabilities(model);
  }

  async countTokens(request: ModelRequest, signal?: AbortSignal): Promise<number> {
    throwIfAborted(signal);
    return estimateTokens(request);
  }

  async *generate(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    throwIfAborted(signal);
    const capabilities = this.#capabilities(request.model);
    assertRequestCapabilities(request, capabilities);
    const timing = timedSignal(signal, this.#timeoutMs);
    let sawDone = false;
    let toolIndex = 0;
    try {
      const response = await this.#fetch(`${this.#baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toOllamaRequest(request)),
        signal: timing.signal,
      });
      if (!response.ok) throw mapHttpError(response.status, this.id);
      for await (const line of readUtf8Lines(response.body, timing.signal)) {
        if (!line.trim()) continue;
        const chunk = parseJsonRecord(line, this.id);
        if (!isRecord(chunk)) malformed('stream chunk');
        if (typeof chunk.error === 'string') {
          throw new ProviderError('HTTP_ERROR', chunk.error, { retryable: false });
        }
        const message = chunk.message;
        if (isRecord(message)) {
          if (typeof message.content === 'string' && message.content) {
            yield { type: 'text_delta', text: message.content };
          }
          const reasoning = message.thinking ?? message.reasoning;
          if (typeof reasoning === 'string' && reasoning) {
            yield { type: 'reasoning_summary_delta', text: reasoning };
          }
          if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) {
            malformed('tool_calls');
          }
          for (const value of (message.tool_calls as unknown[] | undefined) ?? []) {
            if (!isRecord(value) || !isRecord(value.function)) malformed('tool call');
            const fn = value.function;
            if (typeof fn.name !== 'string') malformed('tool name');
            const callId = typeof value.id === 'string' ? value.id : `ollama_call_${toolIndex++}`;
            const argumentText =
              typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {});
            const args = parseJsonRecord(argumentText, `Ollama tool call ${callId}`);
            if (!isRecord(args)) malformed('tool arguments');
            yield { type: 'tool_call_start', callId, name: fn.name };
            yield { type: 'tool_call_arguments_delta', callId, delta: argumentText };
            yield {
              type: 'tool_call_end',
              callId,
              name: fn.name,
              arguments: args as JsonObject,
            };
          }
        }
        if (chunk.done === true) {
          sawDone = true;
          if (typeof chunk.prompt_eval_count === 'number' && typeof chunk.eval_count === 'number') {
            yield {
              type: 'usage',
              usage: { inputTokens: chunk.prompt_eval_count, outputTokens: chunk.eval_count },
            };
          }
          yield {
            type: 'completed',
            finishReason:
              isRecord(message) && Array.isArray(message.tool_calls) ? 'tool_calls' : 'stop',
          };
        }
      }
      if (!sawDone) malformed('stream ended before done');
    } catch (error) {
      throw mapTransportError(error, this.id, timing, signal);
    } finally {
      timing.dispose();
    }
  }

  #capabilities(model: string): ModelCapabilities {
    return {
      ...DEFAULT_CAPABILITIES,
      nativeToolCalls: true,
      structuredOutput: 'json_object',
      ...this.#profiles[model],
    };
  }
}

function toOllamaRequest(request: ModelRequest): JsonObject {
  return {
    model: request.model,
    stream: true,
    messages: [
      ...(request.system ? [{ role: 'system', content: request.system }] : []),
      ...request.messages.map(toOllamaMessage),
    ],
    ...(request.tools?.length ? { tools: request.tools.map(toOllamaTool) } : {}),
    ...(request.output
      ? {
          format: request.output.type === 'json_schema' ? request.output.schema : ('json' as const),
        }
      : {}),
    options: {
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxOutputTokens === undefined ? {} : { num_predict: request.maxOutputTokens }),
      ...(request.stop === undefined ? {} : { stop: request.stop }),
    },
  } as JsonObject;
}

function toOllamaMessage(message: ModelMessage): JsonObject {
  if (message.role === 'tool') {
    return { role: 'tool', content: message.content, tool_call_id: message.callId };
  }
  if ('toolCalls' in message) {
    return {
      role: 'assistant',
      content: message.content ?? '',
      tool_calls: message.toolCalls.map((call) => ({
        id: call.callId,
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function toOllamaTool(tool: ModelTool): JsonObject {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  };
}

function malformed(part: string): never {
  throw new ProviderError('MALFORMED_STREAM', `Malformed Ollama ${part}`);
}

export function createOllamaPlugin(options: OllamaOptions = {}): ForgePlugin {
  const baseUrl = options.baseUrl ?? 'http://127.0.0.1:11434';
  return {
    manifest: {
      apiVersion: FORGE_API_VERSION,
      name: pluginName('forge-provider-ollama'),
      version: '0.1.0',
      runtime: 'trusted',
      entrypoint: './lib/index.js',
      provides: [LLM_PROVIDER_SERVICE.id],
      permissions: { network: [baseUrl] },
    },
    setup(context) {
      context.provide(LLM_PROVIDER_SERVICE, new OllamaProvider(options));
    },
  };
}
