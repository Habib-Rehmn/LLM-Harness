import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAPABILITIES,
  FakeLlmProvider,
  ProviderError,
  providerId,
  type FakeProviderResponse,
  type ModelDescriptor,
  type ModelEvent,
} from '@forge/llm-core';
import { MemorySessionStore } from '@forge/session-core';
import { ToolPipeline, ToolRegistry, type Tool, type ToolGuard } from '@forge/tools-core';
import { AgentRegistry, DefaultAgentFactory, type AgentBudgets } from './index.js';

const allow: ToolGuard = { evaluate: () => ({ decision: 'allow' }) };
const descriptor: ModelDescriptor = {
  id: 'coder',
  providerId: providerId('fake'),
  displayName: 'Fake Coder',
  capabilities: { ...DEFAULT_CAPABILITIES, nativeToolCalls: true, parallelToolCalls: true },
};

function final(text: string): FakeProviderResponse {
  return {
    events: [
      { type: 'text_delta', text },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
      { type: 'completed', finishReason: 'stop' },
    ],
  };
}

function toolCall(callId: string, name = 'read_value', value = 2): FakeProviderResponse {
  const encoded = JSON.stringify({ value });
  const events: ModelEvent[] = [
    { type: 'tool_call_start', callId, name },
    { type: 'tool_call_arguments_delta', callId, delta: encoded.slice(0, 5) },
    { type: 'tool_call_arguments_delta', callId, delta: encoded.slice(5) },
    { type: 'tool_call_end', callId, name, arguments: { value } },
    { type: 'completed', finishReason: 'tool_calls' },
  ];
  return { events };
}

function readTool(name = 'read_value'): Tool {
  return {
    definition: {
      name,
      version: '1.0.0',
      description: 'Read a deterministic value',
      inputSchema: {
        type: 'object',
        required: ['value'],
        properties: { value: { type: 'number' } },
        additionalProperties: false,
      },
      capabilities: ['workspace.read'],
      risk: 'safe',
      readOnly: true,
      idempotent: true,
      timeoutMs: 100,
      maxOutputBytes: 1_000,
      origin: 'official-plugin',
    },
    async execute(arguments_) {
      return { text: `value=${arguments_.value}` };
    },
  };
}

async function harness(
  responses: readonly FakeProviderResponse[],
  options: { budgets?: Partial<AgentBudgets>; mode?: 'ask' | 'plan' | 'code' | 'review' } = {},
) {
  const sessions = new MemorySessionStore();
  const started = await sessions.startThread({ workspaceRoot: '/workspace' });
  const tools = new ToolRegistry();
  tools.register(readTool());
  tools.register({
    ...readTool('write_value'),
    definition: {
      ...readTool('write_value').definition,
      description: 'Change a value',
      capabilities: ['workspace.write'],
      readOnly: false,
      risk: 'sensitive',
    },
  });
  const provider = new FakeLlmProvider('fake', [descriptor], responses);
  const factory = new DefaultAgentFactory(sessions, tools, new ToolPipeline(tools, allow), {
    sleep: async () => undefined,
  });
  const agent = factory.create({
    threadId: started.thread.id,
    workspaceRoot: '/workspace',
    provider,
    model: 'coder',
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.budgets ? { budgets: options.budgets } : {}),
  });
  return { agent, provider, sessions, threadId: started.thread.id, factory };
}

describe('default agent loop', () => {
  it('finishes a deterministic response and persists the turn', async () => {
    const { agent, sessions, threadId } = await harness([final('Done.')]);
    const result = await agent.run('Fix it');
    expect(result).toMatchObject({
      state: 'completed',
      answer: 'Done.',
      usage: { iterations: 1, inputTokens: 10, outputTokens: 3 },
    });
    const snapshot = await sessions.readThread(threadId);
    expect(snapshot.turns[0]?.state).toBe('completed');
    expect(snapshot.items.map(({ kind }) => kind)).toEqual(['UserMessage', 'AssistantMessage']);
  });

  it('executes tools, feeds results back, and supports queued follow-ups', async () => {
    const { agent, provider } = await harness([
      toolCall('call-1'),
      final('First done'),
      final('Follow-up done'),
    ]);
    const first = agent.run('Read the value');
    const followUp = agent.followUp('Check once more');
    expect(agent.inspectInbox().queuedFollowUps).toBe(1);
    expect(await first).toMatchObject({ state: 'completed', answer: 'First done' });
    expect(await followUp).toMatchObject({ state: 'completed', answer: 'Follow-up done' });
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[1]?.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'tool', content: 'value=2' })]),
    );
  });

  it('cancels an active generation and accepts steering during generation', async () => {
    const cancelled = await harness([{ ...final('too late'), delayMs: 100 }]);
    const pendingCancel = cancelled.agent.run('Wait');
    await waitFor(() => cancelled.provider.requests.length === 1);
    cancelled.agent.cancel('stop now');
    expect(await pendingCancel).toMatchObject({ state: 'cancelled', reason: 'stop now' });

    const steered = await harness([{ ...final('old'), delayMs: 100 }, final('new direction')]);
    const pendingSteer = steered.agent.run('Start');
    await waitFor(() => steered.provider.requests.length === 1);
    steered.agent.steer('Use the new direction');
    expect(await pendingSteer).toMatchObject({ state: 'completed', answer: 'new direction' });
    expect(steered.provider.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'Use the new direction' }),
      ]),
    );
  });

  it('recovers from one transient provider failure', async () => {
    const transient = new ProviderError('RATE_LIMITED', 'retry later', { retryable: true });
    const { agent } = await harness([{ events: [], error: transient }, final('Recovered')], {
      budgets: { maxRetries: 1 },
    });
    expect(await agent.run('Retry')).toMatchObject({
      state: 'completed',
      answer: 'Recovered',
      usage: { retries: 1 },
    });
  });

  it('stops on token limits and repeated identical tool loops', async () => {
    const limited = await harness([final('unused')], { budgets: { maxInputTokens: 1 } });
    expect(await limited.agent.run('This exceeds one token')).toMatchObject({
      state: 'limit_reached',
      reason: 'Maximum input-token budget reached',
    });

    const looping = await harness([toolCall('call-a'), toolCall('call-b')], {
      budgets: { repeatedToolCallLimit: 2 },
    });
    expect(await looping.agent.run('Loop')).toMatchObject({
      state: 'limit_reached',
      reason: 'Repeated identical tool loop detected',
      usage: { iterations: 2, toolCalls: 2 },
    });
  });

  it('applies ask, plan, code, and review mode restrictions', async () => {
    for (const mode of ['ask', 'plan', 'review'] as const) {
      const current = await harness([final(mode)], { mode });
      await current.agent.run('Inspect');
      expect(current.provider.requests[0]?.tools?.map(({ name }) => name)).toEqual(['read_value']);
    }
    const code = await harness([final('code')], { mode: 'code' });
    await code.agent.run('Change');
    expect(code.provider.requests[0]?.tools?.map(({ name }) => name)).toEqual([
      'read_value',
      'write_value',
    ]);
  });
});

describe('agent registry', () => {
  it('registers and removes scoped factories', async () => {
    const current = await harness([final('ok')]);
    const registry = new AgentRegistry();
    const dispose = registry.register(current.factory);
    expect(registry.list()).toEqual(['default']);
    dispose();
    expect(registry.list()).toEqual([]);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for deterministic condition');
}
