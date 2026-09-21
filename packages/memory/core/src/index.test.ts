import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ArtifactStore,
  ContextLaneManager,
  type ConversationEntry,
  OutputTrimmer,
  ProjectMemoryStore,
  StructuredCompactor,
  TraceStore,
} from './index.js';

describe('context, artifacts, and compaction', () => {
  it('composes deterministic lanes within budget and externalizes full output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-memory-'));
    const artifacts = new ArtifactStore(join(root, 'artifacts'));
    const trimmed = await new OutputTrimmer(artifacts).trim(
      `head ${'🌍'.repeat(200)} tail`,
      100,
      'tool-1',
    );
    expect(trimmed.truncated).toBe(true);
    expect(Buffer.byteLength(trimmed.text)).toBeLessThanOrEqual(100);
    expect((await artifacts.get(trimmed.artifact?.id ?? '')).toString()).toContain('tail');

    const composition = new ContextLaneManager().compose(
      [
        {
          id: 'rules',
          lane: 'instructions',
          priority: 100,
          provenance: 'project',
          content: 'Run tests.',
        },
        {
          id: 'memory',
          lane: 'memory',
          priority: 50,
          provenance: 'record-1',
          content: 'Uses pnpm.',
        },
        {
          id: 'huge',
          lane: 'artifacts',
          priority: 1,
          provenance: 'tool-1',
          content: 'x'.repeat(500),
        },
      ],
      30,
    );
    expect(composition.included).toEqual(['rules', 'memory']);
    expect(composition.omitted).toEqual(['huge']);
    expect(composition.estimatedTokens).toBeLessThanOrEqual(30);
  });

  it('compacts a long session, preserves decisions/test state, resumes, and rate limits', () => {
    const entries: ConversationEntry[] = Array.from({ length: 30 }, (_, index) => ({
      sequence: index + 1,
      role: index % 3 === 0 ? 'user' : 'assistant',
      content: `Step ${index + 1} ${'detail '.repeat(30)}`,
      tokens: 100,
      ...(index === 8 ? { decision: 'Use TypeScript' } : {}),
      ...(index === 20 ? { testState: '87 tests passing' } : {}),
    }));
    const compactor = new StructuredCompactor({ maximumPerHour: 1 });
    const snapshot = compactor.compact(entries, 1_000);
    expect(snapshot).toMatchObject({
      throughSequence: 24,
      decisions: ['Use TypeScript'],
      testState: '87 tests passing',
    });
    if (!snapshot) throw new Error('Expected a compaction snapshot');
    const resumed = compactor.resume(snapshot, entries);
    expect(resumed[0]?.content).toContain('Use TypeScript');
    expect(resumed[0]?.content).toContain('87 tests passing');
    expect(resumed.slice(1)).toHaveLength(6);
    expect(compactor.compact(entries, 2_000)).toBeUndefined();
  });
});

describe('project memory and telemetry', () => {
  it('retrieves concise current memories with provenance and conflict history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-project-memory-'));
    const path = join(root, 'memory.jsonl');
    const memory = new ProjectMemoryStore(path);
    const old = await memory.remember({
      topic: 'package-manager',
      content: 'Use npm.',
      provenance: { source: 'README', workspaceId: 'workspace-1', sequence: 1 },
    });
    const current = await memory.remember({
      topic: 'package-manager',
      content: 'Use pnpm through Corepack.',
      provenance: { source: 'README', workspaceId: 'workspace-1', sequence: 2 },
    });
    expect(current.supersedes).toBe(old.id);
    expect(await new ProjectMemoryStore(path).retrieve('pnpm package', 'workspace-1')).toEqual([
      expect.objectContaining({
        id: current.id,
        provenance: { source: 'README', workspaceId: 'workspace-1', sequence: 2 },
      }),
    ]);
  });

  it('records inspectable traces and replays without executing side effects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-traces-'));
    const path = join(root, 'traces.jsonl');
    const traces = new TraceStore(path);
    await traces.record('trace-1', 'trace.started', { prompt: 'fix tests' });
    await traces.record('trace-1', 'context', { sections: 4, tokens: 300 });
    await traces.record('trace-1', 'tokens', { inputTokens: 300, outputTokens: 40 });
    await traces.record('trace-1', 'approval', { ruleId: 'ask-shell', decision: 'allow' });
    await traces.record('trace-1', 'tool', { name: 'shell.run', durationMs: 10 }, true);
    await traces.record('trace-1', 'trace.completed', { state: 'completed' });
    const restored = new TraceStore(path);
    expect(await restored.inspect('trace-1')).toEqual({
      traceId: 'trace-1',
      eventCount: 6,
      errors: 0,
      toolCalls: 1,
      approvals: 1,
      inputTokens: 300,
      outputTokens: 40,
    });
    const replay = await restored.replay('trace-1');
    expect(replay.map(({ event }) => event.type)).toEqual([
      'trace.started',
      'context',
      'tokens',
      'approval',
      'tool',
      'trace.completed',
    ]);
    expect(replay.every(({ executed }) => executed === false)).toBe(true);
    expect(replay.find(({ event }) => event.type === 'tool')?.event.sideEffect).toBe(true);
  });
});
