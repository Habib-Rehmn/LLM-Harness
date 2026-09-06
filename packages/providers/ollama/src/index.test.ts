import { describe, expect, it } from 'vitest';
import { collectModelResponse, type ModelMessage, type ModelRequest } from '@forge/llm-core';
import { OllamaProvider } from './index.js';

function fakeOllama(): { fetch: typeof fetch; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const fakeFetch = (async (input, init) => {
    if (String(input).endsWith('/api/tags')) {
      return new Response(JSON.stringify({ models: [{ name: 'coder:latest' }] }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    const parsed = JSON.parse(String(init?.body)) as { messages: ModelMessage[] };
    bodies.push(parsed);
    const hasResult = parsed.messages.some((message) => message.role === 'tool');
    if (hasResult) {
      return new Response(
        [
          JSON.stringify({ message: { content: 'Read complete ✅' }, done: false }),
          JSON.stringify({
            message: { content: '' },
            done: true,
            prompt_eval_count: 21,
            eval_count: 4,
          }),
        ].join('\n'),
        { headers: { 'content-type': 'application/x-ndjson' } },
      );
    }
    return new Response(
      `${JSON.stringify({
        message: {
          content: '',
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'README.md' } } }],
        },
        done: true,
        prompt_eval_count: 12,
        eval_count: 5,
      })}\n`,
      { headers: { 'content-type': 'application/x-ndjson' } },
    );
  }) as typeof fetch;
  return { fetch: fakeFetch, bodies };
}

const tool = {
  name: 'read_file',
  description: 'Read a file without modifying it',
  inputSchema: {
    type: 'object',
    required: ['path'],
    properties: { path: { type: 'string' } },
  },
} as const;

describe('Ollama provider', () => {
  it('passes fake-server discovery and a read-only native-tool round trip', async () => {
    const server = fakeOllama();
    const provider = new OllamaProvider({ baseUrl: 'http://ollama.test', fetch: server.fetch });
    expect(await provider.discoverModels()).toEqual([
      expect.objectContaining({ id: 'coder:latest', providerId: 'ollama' }),
    ]);

    const firstRequest: ModelRequest = {
      model: 'coder:latest',
      messages: [{ role: 'user', content: 'Read README.md' }],
      tools: [tool],
      toolChoice: 'required',
    };
    const first = await collectModelResponse(provider.generate(firstRequest));
    expect(first.toolCalls).toEqual([
      expect.objectContaining({ name: 'read_file', arguments: { path: 'README.md' } }),
    ]);

    const call = first.toolCalls[0];
    if (!call) throw new Error('Expected a tool call');
    const second = await collectModelResponse(
      provider.generate({
        ...firstRequest,
        messages: [
          ...firstRequest.messages,
          { role: 'assistant', toolCalls: [call] },
          { role: 'tool', callId: call.callId, content: '# Forge' },
        ],
        toolChoice: 'auto',
      }),
    );
    expect(second).toMatchObject({
      text: 'Read complete ✅',
      usage: { inputTokens: 21, outputTokens: 4 },
      finishReason: 'stop',
    });
    expect(server.bodies).toHaveLength(2);
  });

  it('honors model profiles when native tools are unavailable', async () => {
    const server = fakeOllama();
    const provider = new OllamaProvider({
      baseUrl: 'http://ollama.test',
      profiles: { 'coder:latest': { nativeToolCalls: false } },
      fetch: server.fetch,
    });
    await expect(
      collectModelResponse(
        provider.generate({
          model: 'coder:latest',
          messages: [{ role: 'user', content: 'read' }],
          tools: [tool],
        }),
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FEATURE' });
  });
});

const localModel = process.env.OLLAMA_TEST_MODEL;
it.skipIf(!localModel)('completes an opt-in local Ollama read-only tool request', async () => {
  const provider = new OllamaProvider();
  const response = await collectModelResponse(
    provider.generate({
      model: localModel ?? '',
      messages: [{ role: 'user', content: 'Call read_file for README.md.' }],
      tools: [tool],
      toolChoice: 'required',
    }),
  );
  expect(response.toolCalls.some((call) => call.name === 'read_file')).toBe(true);
});
