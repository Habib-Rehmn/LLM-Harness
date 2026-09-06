import { ProviderError, throwIfAborted } from './index.js';

export async function* readUtf8Lines(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): AsyncIterable<string> {
  if (!body) throw new ProviderError('MALFORMED_STREAM', 'Provider response has no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      throwIfAborted(signal);
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let boundary = buffer.indexOf('\n');
      while (boundary >= 0) {
        const line = buffer.slice(0, boundary).replace(/\r$/, '');
        buffer = buffer.slice(boundary + 1);
        yield line;
        boundary = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) yield buffer.replace(/\r$/, '');
  } finally {
    reader.releaseLock();
  }
}

export async function* readSseData(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): AsyncIterable<string> {
  let data: string[] = [];
  for await (const line of readUtf8Lines(body, signal)) {
    if (line === '') {
      if (data.length > 0) yield data.join('\n');
      data = [];
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (data.length > 0) yield data.join('\n');
}

export function parseJsonRecord(value: string, source: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new ProviderError('MALFORMED_STREAM', `Malformed JSON from ${source}`, { cause: error });
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mapHttpError(status: number, provider: string): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError('AUTHENTICATION', `${provider} rejected authentication`, { status });
  }
  if (status === 404) {
    return new ProviderError('MODEL_NOT_FOUND', `${provider} model or endpoint was not found`, {
      status,
    });
  }
  if (status === 408 || status === 429 || status >= 500) {
    return new ProviderError(
      status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR',
      `${provider} returned HTTP ${status}`,
      { status, retryable: true },
    );
  }
  return new ProviderError('HTTP_ERROR', `${provider} returned HTTP ${status}`, { status });
}

export interface TimedSignal {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly dispose: () => void;
}

export function timedSignal(external: AbortSignal | undefined, timeoutMs: number): TimedSignal {
  const controller = new AbortController();
  let timeout = false;
  const abortFromExternal = () => controller.abort(external?.reason);
  if (external?.aborted) abortFromExternal();
  else external?.addEventListener('abort', abortFromExternal, { once: true });
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort(new Error('timeout'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', abortFromExternal);
    },
  };
}

export function mapTransportError(
  error: unknown,
  provider: string,
  timing: TimedSignal,
  external?: AbortSignal,
): ProviderError {
  if (error instanceof ProviderError) return error;
  if (timing.timedOut()) {
    return new ProviderError('TIMEOUT', `${provider} request timed out`, {
      retryable: true,
      cause: error,
    });
  }
  if (external?.aborted) {
    return new ProviderError('CANCELLED', `${provider} request was cancelled`, { cause: error });
  }
  return new ProviderError('PROVIDER_UNAVAILABLE', `${provider} request failed`, {
    retryable: true,
    cause: error,
  });
}
