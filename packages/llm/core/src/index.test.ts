import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAPABILITIES,
  FakeLlmProvider,
  ProviderError,
  ProviderRegistry,
  collectModelResponse,
  prepareToolRequest,
  providerId,
  selectToolProtocol,
  type ModelDescriptor,
  type ModelEvent,
  type ModelRequest,
} from './index.js';

const descriptor: ModelDescriptor = {
  id: 'fake-coder',
  providerId: providerId('fake'),
  displayName: 'Fake Coder',
  capabilities: { ...DEFAULT_CAPABILITIES, nativeToolCalls: true },
};

const request: ModelRequest = {
  model: 'fake-coder',
  messages: [{ role: 'user', content: 'hello' }],
};

describe('LLM core', () => {
  it('registers providers and discovers deterministic model references', async () => {
    const registry = new ProviderRegistry();
    const provider = new FakeLlmProvider(
      'fake',
      [descriptor],
      [{ events: [{ type: 'completed', finishReason: 'stop' }] }],
    );
    const unregister = registry.register(provider);
    expect(await registry.discoverModels()).toEqual([descriptor]);
    expect(await registry.resolveModel('fake/fake-coder')).toEqual(descriptor);
    unregister();
    expect(() => registry.get('fake')).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }),
    );
  });

  it('collects deterministic fake responses and rejects malformed lifecycles', async () => {
    const provider = new FakeLlmProvider(
      'fake',
      [descriptor],
      [
        {
          events: [
            { type: 'text_delta', text: 'Hi 🌍' },
            { type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } },
            { type: 'completed', finishReason: 'stop' },
          ],
        },
      ],
    );
    expect(await collectModelResponse(provider.generate(request))).toEqual({
      text: 'Hi 🌍',
      reasoningSummary: '',
      toolCalls: [],
      usage: { inputTokens: 2, outputTokens: 3 },
      finishReason: 'stop',
    });
    expect(provider.requests).toEqual([request]);

    async function* malformed(): AsyncIterable<ModelEvent> {
      yield { type: 'tool_call_arguments_delta', callId: 'missing', delta: '{}' };
    }
    await expect(collectModelResponse(malformed())).rejects.toMatchObject({
      code: 'MALFORMED_STREAM',
    });
  });

  it('propagates cancellation through the deterministic provider', async () => {
    const provider = new FakeLlmProvider(
      'fake',
      [descriptor],
      [
        {
          delayMs: 50,
          events: [{ type: 'completed', finishReason: 'stop' }],
        },
      ],
    );
    const controller = new AbortController();
    const response = collectModelResponse(provider.generate(request, controller.signal));
    controller.abort('user cancelled');
    await expect(response).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('selects native, constrained, prompted, and disabled tool protocols explicitly', () => {
    expect(selectToolProtocol({ ...DEFAULT_CAPABILITIES, nativeToolCalls: true }).level).toBe(
      'native',
    );
    expect(
      selectToolProtocol({ ...DEFAULT_CAPABILITIES, structuredOutput: 'json_schema' }).level,
    ).toBe('constrained_json');
    expect(selectToolProtocol(DEFAULT_CAPABILITIES, { allowPromptedFallback: true }).level).toBe(
      'prompted_protocol',
    );
    expect(selectToolProtocol(DEFAULT_CAPABILITIES).level).toBe('none');

    const prepared = prepareToolRequest(
      {
        ...request,
        tools: [
          {
            name: 'read_file',
            description: 'Read a file',
            inputSchema: { type: 'object' },
          },
        ],
      },
      { ...DEFAULT_CAPABILITIES, structuredOutput: 'json_schema' },
    );
    expect(prepared.selection.level).toBe('constrained_json');
    expect(prepared.request.tools).toEqual([]);
    expect(prepared.request.output?.type).toBe('json_schema');

    const prompted = prepareToolRequest(
      { ...prepared.request, tools: [{ name: 'read_file', description: 'Read', inputSchema: {} }] },
      { ...DEFAULT_CAPABILITIES, supportsSystemMessage: false },
      { allowPromptedFallback: true },
    );
    expect(prompted.request.system).toBeUndefined();
    expect(prompted.request.messages[0]).toEqual(
      expect.objectContaining({ role: 'user', content: expect.stringContaining('FORGE_TOOL') }),
    );
  });

  it('uses typed provider failures', () => {
    const error = new ProviderError('RATE_LIMITED', 'slow down', { retryable: true, status: 429 });
    expect(error).toMatchObject({ code: 'RATE_LIMITED', retryable: true, status: 429 });
  });
});
