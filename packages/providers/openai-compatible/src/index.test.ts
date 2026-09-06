import { describe, expect, it } from 'vitest';
import { collectModelResponse, type ModelRequest } from '@forge/llm-core';
import { OpenAiCompatibleProvider } from './index.js';

const request: ModelRequest = {
  model: 'coder',
  system: 'You are a coding assistant.',
  messages: [{ role: 'user', content: 'Read the Unicode path' }],
  tools: [
    {
      name: 'read_file',
      description: 'Read a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ],
};

function byteStream(text: string, cuts: readonly number[] = []): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const boundaries = [...cuts, bytes.length];
  let start = 0;
  return new ReadableStream({
    start(controller) {
      for (const end of boundaries) {
        controller.enqueue(bytes.slice(start, end));
        start = end;
      }
      controller.close();
    },
  });
}

function sse(values: readonly unknown[]): string {
  return `${values
    .map((value) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`)
    .join('')}data: [DONE]\n\n`;
}

describe('OpenAI-compatible provider', () => {
  it('streams Unicode, reconstructs fragmented tool arguments, and reports usage', async () => {
    let wireBody: unknown;
    const payload = sse([
      { choices: [{ delta: { content: 'Hello 🌍 ' }, finish_reason: null }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  function: { name: 'read_file', arguments: '{"path":"src/' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '😀.ts"}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { choices: [], usage: { prompt_tokens: 17, completion_tokens: 8 } },
    ]);
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'http://provider.test/v1',
      apiKey: 'test-key',
      models: [{ id: 'coder' }],
      fetch: (async (_input, init) => {
        wireBody = JSON.parse(String(init?.body));
        return new Response(byteStream(payload, [7, 31, 67, 113]), {
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as typeof fetch,
    });

    const result = await collectModelResponse(provider.generate(request));
    expect(result).toEqual({
      text: 'Hello 🌍 ',
      reasoningSummary: '',
      toolCalls: [{ callId: 'call_1', name: 'read_file', arguments: { path: 'src/😀.ts' } }],
      usage: { inputTokens: 17, outputTokens: 8 },
      finishReason: 'tool_calls',
    });
    expect(wireBody).toMatchObject({ model: 'coder', stream: true });
  });

  it('maps timeout and cancellation distinctly', async () => {
    const waitingFetch = ((_: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) reject(init.signal.reason);
        else {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }
      })) as typeof fetch;
    const timeoutProvider = new OpenAiCompatibleProvider({
      baseUrl: 'http://provider.test/v1',
      models: [{ id: 'coder' }],
      timeoutMs: 5,
      fetch: waitingFetch,
    });
    await expect(collectModelResponse(timeoutProvider.generate(request))).rejects.toMatchObject({
      code: 'TIMEOUT',
    });

    const controller = new AbortController();
    const cancelProvider = new OpenAiCompatibleProvider({
      baseUrl: 'http://provider.test/v1',
      models: [{ id: 'coder' }],
      timeoutMs: 1_000,
      fetch: waitingFetch,
    });
    const pending = collectModelResponse(cancelProvider.generate(request, controller.signal));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('rejects malformed streams and fragmented argument JSON', async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'http://provider.test/v1',
      models: [{ id: 'coder' }],
      fetch: (async () =>
        new Response(
          sse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, id: 'bad', function: { name: 'read_file', arguments: '{' } },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            },
          ]),
        )) as typeof fetch,
    });
    await expect(collectModelResponse(provider.generate(request))).rejects.toMatchObject({
      code: 'MALFORMED_STREAM',
    });
  });
});
