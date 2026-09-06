import {
  type JsonObject,
  type JsonValue,
  type LlmProvider,
  type ModelCapabilities,
  type ModelDescriptor,
  type ModelEvent,
  type ModelRequest,
  LLM_PROVIDER_SERVICE,
  ProviderError,
  assertRequestCapabilities,
  estimateTokens,
  isRecord,
  mapHttpError,
  mapTransportError,
  parseJsonRecord,
  providerId,
  readSseData,
  readUtf8Lines,
  throwIfAborted,
  timedSignal,
} from '@forge/llm-core';
import { randomUUID } from 'node:crypto';
import { FORGE_API_VERSION, type ForgePlugin, pluginName } from '@forge/kernel-contracts';

export type CustomStreamFormat = 'json' | 'ndjson' | 'sse';

export interface CustomResponseMapping {
  readonly text?: string;
  readonly reasoning?: string;
  readonly toolCalls?: string;
  readonly usageInput?: string;
  readonly usageOutput?: string;
  readonly done?: string;
  readonly finishReason?: string;
}

export interface CustomHttpOptions {
  readonly id?: string;
  readonly endpoint: string;
  readonly models: readonly {
    readonly id: string;
    readonly displayName?: string;
    readonly capabilities: ModelCapabilities;
  }[];
  readonly requestTemplate: JsonObject;
  readonly response: CustomResponseMapping;
  readonly streamFormat?: CustomStreamFormat;
  readonly headers?: Readonly<Record<string, string>>;
  readonly authentication?: {
    readonly header: string;
    readonly scheme?: string;
    readonly secretRef: string;
  };
  readonly resolveSecret?: (reference: string) => string | Promise<string>;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

export class CustomHttpProvider implements LlmProvider {
  readonly id;
  readonly #options: CustomHttpOptions;
  readonly #fetch: typeof fetch;

  constructor(options: CustomHttpOptions) {
    this.id = providerId(options.id ?? 'custom-http');
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (options.authentication && !options.resolveSecret) {
      throw new ProviderError(
        'AUTHENTICATION',
        'A secret resolver is required when custom HTTP authentication is configured',
      );
    }
  }

  async discoverModels(signal?: AbortSignal): Promise<readonly ModelDescriptor[]> {
    throwIfAborted(signal);
    return this.#options.models.map((model) => ({
      id: model.id,
      providerId: this.id,
      displayName: model.displayName ?? model.id,
      capabilities: model.capabilities,
    }));
  }

  async capabilities(model: string, signal?: AbortSignal): Promise<ModelCapabilities> {
    throwIfAborted(signal);
    const profile = this.#model(model);
    return profile.capabilities;
  }

  async countTokens(request: ModelRequest, signal?: AbortSignal): Promise<number | undefined> {
    throwIfAborted(signal);
    return this.#model(request.model).capabilities.tokenCounting === 'none'
      ? undefined
      : estimateTokens(request);
  }

  async *generate(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    throwIfAborted(signal);
    const profile = this.#model(request.model).capabilities;
    assertRequestCapabilities(request, profile);

    const timing = timedSignal(signal, this.#options.timeoutMs ?? 120_000);
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...this.#options.headers,
      };
      if (this.#options.authentication) {
        const secret = await this.#options.resolveSecret?.(this.#options.authentication.secretRef);
        if (!secret) throw new ProviderError('AUTHENTICATION', 'Secret resolver returned no value');
        headers[this.#options.authentication.header] =
          `${this.#options.authentication.scheme ?? ''}${secret}`;
      }
      const response = await this.#fetch(this.#options.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(applyTemplate(this.#options.requestTemplate, request)),
        signal: timing.signal,
      });
      if (!response.ok) throw mapHttpError(response.status, this.id);
      let sawDone = this.#options.response.done === undefined;
      let finishReason: unknown;
      if ((this.#options.streamFormat ?? 'json') === 'json') {
        const value = (await response.json()) as unknown;
        yield* this.#mapChunk(value);
        sawDone = true;
        finishReason = getPath(value, this.#options.response.finishReason);
      } else {
        const records =
          this.#options.streamFormat === 'sse'
            ? readSseData(response.body, timing.signal)
            : readUtf8Lines(response.body, timing.signal);
        for await (const record of records) {
          if (!record.trim() || record === '[DONE]') continue;
          const value = parseJsonRecord(record, this.id);
          yield* this.#mapChunk(value);
          if (getPath(value, this.#options.response.done) === true) sawDone = true;
          finishReason = getPath(value, this.#options.response.finishReason) ?? finishReason;
        }
      }
      if (!sawDone) malformed('stream ended before configured done marker');
      yield { type: 'completed', finishReason: mapFinishReason(finishReason) };
    } catch (error) {
      throw mapTransportError(error, this.id, timing, signal);
    } finally {
      timing.dispose();
    }
  }

  *#mapChunk(value: unknown): Iterable<ModelEvent> {
    if (!isRecord(value)) malformed('response chunk is not an object');
    const mapping = this.#options.response;
    const text = getPath(value, mapping.text);
    if (typeof text === 'string' && text) yield { type: 'text_delta', text };
    const reasoning = getPath(value, mapping.reasoning);
    if (typeof reasoning === 'string' && reasoning) {
      yield { type: 'reasoning_summary_delta', text: reasoning };
    }
    const calls = getPath(value, mapping.toolCalls);
    if (calls !== undefined && !Array.isArray(calls)) malformed('mapped toolCalls is not an array');
    for (const call of (calls as unknown[] | undefined) ?? []) {
      if (!isRecord(call) || typeof call.name !== 'string') malformed('mapped tool call');
      const callId = typeof call.id === 'string' ? call.id : `custom_call_${randomUUID()}`;
      const argumentText =
        typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {});
      const args = parseJsonRecord(argumentText, `custom tool call ${callId}`);
      if (!isRecord(args)) malformed('mapped tool arguments');
      yield { type: 'tool_call_start', callId, name: call.name };
      yield { type: 'tool_call_arguments_delta', callId, delta: argumentText };
      yield {
        type: 'tool_call_end',
        callId,
        name: call.name,
        arguments: args as JsonObject,
      };
    }
    const input = getPath(value, mapping.usageInput);
    const output = getPath(value, mapping.usageOutput);
    if (input !== undefined || output !== undefined) {
      if (typeof input !== 'number' || typeof output !== 'number') malformed('mapped usage');
      yield { type: 'usage', usage: { inputTokens: input, outputTokens: output } };
    }
  }

  #model(id: string) {
    const model = this.#options.models.find((candidate) => candidate.id === id);
    if (!model) throw new ProviderError('MODEL_NOT_FOUND', `Custom model ${id} was not found`);
    return model;
  }
}

function applyTemplate(template: JsonValue, request: ModelRequest): JsonValue {
  if (Array.isArray(template)) return template.map((entry) => applyTemplate(entry, request));
  if (isRecord(template)) {
    return Object.fromEntries(
      Object.entries(template).map(([key, value]) => [
        key,
        applyTemplate(value as JsonValue, request),
      ]),
    );
  }
  if (typeof template !== 'string' || !template.startsWith('$')) return template;
  const values: Readonly<Record<string, JsonValue | undefined>> = {
    $model: request.model,
    $messages: request.messages as unknown as JsonValue,
    $system: request.system,
    $tools: request.tools as unknown as JsonValue,
    $toolChoice: request.toolChoice as unknown as JsonValue,
    $output: request.output as unknown as JsonValue,
    $maxOutputTokens: request.maxOutputTokens,
    $temperature: request.temperature,
    $stop: request.stop,
    $metadata: request.metadata as JsonObject | undefined,
  };
  if (!Object.hasOwn(values, template)) return template;
  return values[template] ?? null;
}

function getPath(value: unknown, path?: string): unknown {
  if (!path) return undefined;
  let current = value;
  for (const segment of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function malformed(message: string): never {
  throw new ProviderError('MALFORMED_STREAM', `Malformed custom HTTP response: ${message}`);
}

function mapFinishReason(value: unknown) {
  if (value === 'tool_calls') return 'tool_calls' as const;
  if (value === 'length') return 'length' as const;
  if (value === 'content_filter') return 'content_filter' as const;
  if (value === 'error') return 'error' as const;
  return 'stop' as const;
}

export function createCustomHttpPlugin(options: CustomHttpOptions): ForgePlugin {
  return {
    manifest: {
      apiVersion: FORGE_API_VERSION,
      name: pluginName('forge-provider-custom-http'),
      version: '0.1.0',
      runtime: 'trusted',
      entrypoint: './lib/index.js',
      provides: [LLM_PROVIDER_SERVICE.id],
      permissions: { network: [options.endpoint] },
    },
    setup(context) {
      context.provide(LLM_PROVIDER_SERVICE, new CustomHttpProvider(options));
    },
  };
}
