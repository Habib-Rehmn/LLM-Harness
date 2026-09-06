import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAPABILITIES,
  collectModelResponse,
  prepareToolRequest,
  type ModelRequest,
} from '@forge/llm-core';
import { CustomHttpProvider } from './index.js';

const request: ModelRequest = {
  model: 'private-coder',
  system: 'Be concise.',
  messages: [{ role: 'user', content: 'Say hello' }],
  temperature: 0,
};

describe('custom HTTP provider', () => {
  it('applies request templates, secret references, response mappings, and NDJSON streaming', async () => {
    let receivedBody: unknown;
    let authorization: string | null = null;
    const provider = new CustomHttpProvider({
      endpoint: 'http://custom.test/generate',
      models: [
        {
          id: 'private-coder',
          capabilities: { ...DEFAULT_CAPABILITIES, structuredOutput: 'json_schema' },
        },
      ],
      requestTemplate: {
        selected_model: '$model',
        conversation: '$messages',
        instruction: '$system',
        randomness: '$temperature',
      },
      response: {
        text: 'delta.text',
        reasoning: 'delta.reasoning',
        usageInput: 'metrics.input',
        usageOutput: 'metrics.output',
        done: 'done',
      },
      streamFormat: 'ndjson',
      authentication: {
        header: 'authorization',
        scheme: 'Bearer ',
        secretRef: 'env:CUSTOM_TOKEN',
      },
      resolveSecret(reference) {
        expect(reference).toBe('env:CUSTOM_TOKEN');
        return 'resolved-at-runtime';
      },
      fetch: (async (_input, init) => {
        receivedBody = JSON.parse(String(init?.body));
        authorization = new Headers(init?.headers).get('authorization');
        return new Response(
          [
            JSON.stringify({ delta: { text: 'Hello 世界', reasoning: 'brief' }, done: false }),
            JSON.stringify({ metrics: { input: 9, output: 3 }, done: true }),
          ].join('\n'),
        );
      }) as typeof fetch,
    });

    expect(await provider.discoverModels()).toEqual([
      expect.objectContaining({ id: 'private-coder', providerId: 'custom-http' }),
    ]);
    expect(await collectModelResponse(provider.generate(request))).toEqual({
      text: 'Hello 世界',
      reasoningSummary: 'brief',
      toolCalls: [],
      usage: { inputTokens: 9, outputTokens: 3 },
      finishReason: 'stop',
    });
    expect(receivedBody).toEqual({
      selected_model: 'private-coder',
      conversation: request.messages,
      instruction: 'Be concise.',
      randomness: 0,
    });
    expect(authorization).toBe('Bearer resolved-at-runtime');
  });

  it('supports mapped native tool calls and explicit fallback preparation', async () => {
    const native = new CustomHttpProvider({
      endpoint: 'http://custom.test/generate',
      models: [
        {
          id: 'private-coder',
          capabilities: { ...DEFAULT_CAPABILITIES, nativeToolCalls: true },
        },
      ],
      requestTemplate: { model: '$model', tools: '$tools' },
      response: { toolCalls: 'result.calls' },
      fetch: (async () =>
        new Response(
          JSON.stringify({
            result: {
              calls: [{ id: 'custom_1', name: 'read_file', arguments: { path: 'README.md' } }],
            },
          }),
        )) as typeof fetch,
    });
    const withTools: ModelRequest = {
      ...request,
      tools: [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object' } }],
    };
    expect((await collectModelResponse(native.generate(withTools))).toolCalls).toEqual([
      { callId: 'custom_1', name: 'read_file', arguments: { path: 'README.md' } },
    ]);

    const fallback = prepareToolRequest(withTools, DEFAULT_CAPABILITIES, {
      allowPromptedFallback: true,
    });
    expect(fallback.selection).toMatchObject({ level: 'prompted_protocol', degraded: true });
    expect(fallback.request.system).toContain('FORGE_TOOL');
  });
});
