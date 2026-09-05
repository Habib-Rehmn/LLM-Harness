import { appendFile, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { threadId } from '@forge/kernel-contracts';
import {
  JsonlSessionStore,
  MemorySessionStore,
  projectModelHistory,
  type SessionIdKind,
  type SessionStoreOptions,
} from './index.js';

function deterministicOptions(): SessionStoreOptions {
  let id = 0;
  let tick = 0;
  return {
    createId(kind: SessionIdKind): string {
      id += 1;
      return `${kind}_${id}`;
    },
    clock(): string {
      tick += 1;
      return `2026-09-05T00:00:${String(tick).padStart(2, '0')}.000Z`;
    },
  };
}

async function recordConversation(store: MemorySessionStore | JsonlSessionStore) {
  const started = await store.startThread({
    workspaceRoot: '/workspace/demo',
    configSnapshot: { profile: 'default', token: { secretRef: 'env:MODEL_TOKEN' } },
  });
  const thread = started.thread.id;
  const turn = await store.startTurn(thread);
  const step = await store.startStep(thread, turn, 0, 'Understand request');
  await store.appendCompletedItem(thread, {
    turnId: turn,
    stepId: step,
    kind: 'UserMessage',
    payload: { content: 'Fix the parser' },
  });
  const assistant = await store.startItem(thread, {
    turnId: turn,
    stepId: step,
    kind: 'AssistantMessage',
    payload: { content: 'I fixed the parser.' },
  });
  await store.appendItemDelta(thread, assistant, 'I fixed');
  await store.completeItem(thread, assistant);
  await store.completeStep(thread, turn, step);
  await store.transitionTurn(thread, turn, 'completed');
  return { thread, turn };
}

describe('session core', () => {
  it('records typed lifecycle events and projects only model-visible history', async () => {
    const store = new MemorySessionStore(deterministicOptions());
    const { thread } = await recordConversation(store);
    const snapshot = await store.readThread(thread);

    expect(snapshot.turns[0]?.state).toBe('completed');
    expect(snapshot.steps[0]?.state).toBe('completed');
    expect(snapshot.items.map((item) => item.state)).toEqual(['completed', 'completed']);
    expect(projectModelHistory(snapshot)).toEqual([
      { type: 'message', role: 'user', content: 'Fix the parser' },
      { type: 'message', role: 'assistant', content: 'I fixed the parser.' },
    ]);
    expect(snapshot.events.map((event) => event.sequence)).toEqual(
      Array.from({ length: snapshot.events.length }, (_, index) => index + 1),
    );
  });

  it('replays JSONL to exactly the same snapshot and model input', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'forge-session-replay-'));
    const writer = new JsonlSessionStore(directory, deterministicOptions());
    const { thread } = await recordConversation(writer);
    const recorded = await writer.readThread(thread);

    const reader = new JsonlSessionStore(directory);
    const replayed = await reader.resumeThread(thread);
    expect(replayed).toEqual(recorded);
    expect(projectModelHistory(replayed)).toEqual(projectModelHistory(recorded));
  });

  it('discards a partial final JSONL record after a simulated interrupted write', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'forge-session-recovery-'));
    const store = new JsonlSessionStore(directory, deterministicOptions());
    const { thread } = await recordConversation(store);
    const before = await store.readThread(thread);
    const path = join(directory, `${thread}.jsonl`);

    await appendFile(path, '{"schemaVersion":"forge.session/v1","eventId":');
    const recovered = await store.resumeThread(thread);
    expect(recovered).toEqual(before);
    expect(await readFile(path, 'utf8')).toMatch(/\n$/);

    const fork = await store.forkThread(thread);
    expect(projectModelHistory(fork)).toEqual(projectModelHistory(before));
  });

  it('forks through a selected turn and archives without hiding history', async () => {
    const store = new MemorySessionStore(deterministicOptions());
    const { thread, turn } = await recordConversation(store);
    const fork = await store.forkThread(thread, turn);

    expect(fork.thread.id).not.toBe(thread);
    expect(fork.thread.forkedFrom).toEqual({ threadId: thread, throughTurnId: turn });
    expect(projectModelHistory(fork)).toEqual(projectModelHistory(await store.readThread(thread)));

    await store.archiveThread(thread);
    expect(await store.listThreads()).toHaveLength(1);
    expect(await store.listThreads({ includeArchived: true })).toHaveLength(2);
    expect((await store.readThread(thread)).thread.archivedAt).toBeDefined();
  });

  it('resolves approvals and retains post-boundary history during compaction', async () => {
    const store = new MemorySessionStore(deterministicOptions());
    const started = await store.startThread({ workspaceRoot: '/workspace/demo' });
    const turn = await store.startTurn(started.thread.id);
    await store.appendCompletedItem(started.thread.id, {
      turnId: turn,
      kind: 'UserMessage',
      payload: { content: 'old request' },
    });
    const boundary = (await store.readThread(started.thread.id)).events.length;
    await store.appendCompletedItem(started.thread.id, {
      turnId: turn,
      kind: 'AssistantMessage',
      payload: { content: 'keep me' },
    });
    await store.compactContext(started.thread.id, turn, 'Earlier work was summarized.', boundary);

    expect(projectModelHistory(await store.readThread(started.thread.id))).toEqual([
      {
        type: 'message',
        role: 'system',
        content: 'Conversation summary:\nEarlier work was summarized.',
      },
      { type: 'message', role: 'assistant', content: 'keep me' },
    ]);

    const approval = await store.startItem(started.thread.id, {
      turnId: turn,
      kind: 'ApprovalRequest',
      payload: { approvalId: 'approval-1', reason: 'Run tests' },
    });
    await store.transitionTurn(started.thread.id, turn, 'waiting_for_approval');
    const resolved = await store.resolveApproval(started.thread.id, 'approval-1', 'allow');
    expect(resolved.items.find((item) => item.id === approval)?.state).toBe('completed');
    expect(resolved.turns[0]?.state).toBe('running');
  });

  it('rejects invalid IDs before they can become JSONL paths', async () => {
    const store = new MemorySessionStore();
    await expect(store.readThread(threadId('thread_missing'))).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
    expect(() => threadId('../outside')).toThrowError(
      expect.objectContaining({ code: 'INVALID_SESSION' }),
    );
    await expect(
      store.startThread({
        workspaceRoot: '/workspace/demo',
        configSnapshot: { apiKey: 'resolved-secret' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SESSION' });
  });
});
