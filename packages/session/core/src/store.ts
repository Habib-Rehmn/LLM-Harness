import { randomUUID } from 'node:crypto';
import {
  ForgeError,
  type ItemId,
  type SessionEventId,
  type StepId,
  type ThreadId,
  type TurnId,
  itemId,
  sessionEventId,
  serviceToken,
  stepId,
  threadId,
  turnId,
} from '@forge/kernel-contracts';
import type { SessionJournal } from './journal.js';
import { JsonlSessionJournal, MemorySessionJournal } from './journal.js';
import {
  SESSION_SCHEMA_VERSION,
  assertJsonValue,
  assertSecretReferences,
  type ItemKind,
  type ItemPayloads,
  type JsonObject,
  type JsonValue,
  type SessionEvent,
  type SessionSnapshot,
  type TurnState,
  validateItemPayload,
} from './protocol.js';
import { assertTurnTransition, replaySession } from './reducer.js';

export type SessionIdKind = 'thread' | 'turn' | 'step' | 'item' | 'event';

export interface SessionStoreOptions {
  readonly clock?: () => string;
  readonly createId?: (kind: SessionIdKind) => string;
}

export interface StartThreadInput {
  readonly workspaceRoot: string;
  readonly configSnapshot?: JsonObject;
}

export interface ListThreadsOptions {
  readonly includeArchived?: boolean;
}

export interface StartItemInput<Kind extends ItemKind> {
  readonly turnId: TurnId;
  readonly stepId?: StepId;
  readonly kind: Kind;
  readonly payload: ItemPayloads[Kind];
}

export interface SessionStore {
  startThread(input: StartThreadInput): Promise<SessionSnapshot>;
  listThreads(options?: ListThreadsOptions): Promise<readonly SessionSnapshot[]>;
  readThread(id: ThreadId): Promise<SessionSnapshot>;
  resumeThread(id: ThreadId): Promise<SessionSnapshot>;
  forkThread(id: ThreadId, throughTurnId?: TurnId): Promise<SessionSnapshot>;
  archiveThread(id: ThreadId): Promise<SessionSnapshot>;
  startTurn(id: ThreadId): Promise<TurnId>;
  transitionTurn(id: ThreadId, turn: TurnId, state: TurnState): Promise<SessionSnapshot>;
  steerTurn(id: ThreadId, turn: TurnId, content: string): Promise<ItemId>;
  cancelTurn(id: ThreadId, turn: TurnId): Promise<SessionSnapshot>;
  startStep(id: ThreadId, turn: TurnId, index: number, label?: string): Promise<StepId>;
  completeStep(id: ThreadId, turn: TurnId, step: StepId): Promise<SessionSnapshot>;
  failStep(id: ThreadId, turn: TurnId, step: StepId, message: string): Promise<SessionSnapshot>;
  startItem<Kind extends ItemKind>(id: ThreadId, input: StartItemInput<Kind>): Promise<ItemId>;
  appendItemDelta(id: ThreadId, item: ItemId, delta: JsonValue): Promise<SessionSnapshot>;
  completeItem(id: ThreadId, item: ItemId, result?: JsonValue): Promise<SessionSnapshot>;
  failItem(id: ThreadId, item: ItemId, message: string, code?: string): Promise<SessionSnapshot>;
  appendCompletedItem<Kind extends ItemKind>(
    id: ThreadId,
    input: StartItemInput<Kind>,
  ): Promise<ItemId>;
  resolveApproval(
    id: ThreadId,
    approvalId: string,
    decision: 'allow' | 'deny',
  ): Promise<SessionSnapshot>;
  compactContext(
    id: ThreadId,
    turn: TurnId,
    summary: string,
    throughSequence: number,
  ): Promise<ItemId>;
  restoreCheckpoint(id: ThreadId, turn: TurnId, checkpointId: string): Promise<ItemId>;
}

export const SESSION_STORE_SERVICE = serviceToken<SessionStore>('forge.session-store');

type NewEvent = SessionEvent extends infer Candidate
  ? Candidate extends SessionEvent
    ? Omit<Candidate, 'schemaVersion' | 'eventId' | 'sequence' | 'timestamp' | 'threadId'>
    : never
  : never;

export class EventSessionStore implements SessionStore {
  readonly #journal: SessionJournal;
  readonly #clock: () => string;
  readonly #createId: (kind: SessionIdKind) => string;
  #pending: Promise<void> = Promise.resolve();

  constructor(journal: SessionJournal, options: SessionStoreOptions = {}) {
    this.#journal = journal;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#createId = options.createId ?? ((kind) => `${kind}_${randomUUID()}`);
  }

  async startThread(input: StartThreadInput): Promise<SessionSnapshot> {
    return this.#exclusive(async () => {
      if (input.workspaceRoot.length === 0) {
        throw new ForgeError('INVALID_SESSION', 'workspaceRoot cannot be empty');
      }
      const configSnapshot = input.configSnapshot ?? {};
      assertJsonValue(configSnapshot, 'configSnapshot');
      assertSecretReferences(configSnapshot);
      const id = this.#newThreadId();
      const event = this.#event(id, 1, {
        type: 'thread.created',
        data: { workspaceRoot: input.workspaceRoot, configSnapshot },
      });
      await this.#journal.append(id, [event]);
      return replaySession([event]);
    });
  }

  async listThreads(options: ListThreadsOptions = {}): Promise<readonly SessionSnapshot[]> {
    await this.#pending;
    const snapshots = await Promise.all(
      (await this.#journal.listThreadIds()).map((id) => this.#readExisting(id)),
    );
    return snapshots.filter((snapshot) => options.includeArchived || !snapshot.thread.archivedAt);
  }

  async readThread(id: ThreadId): Promise<SessionSnapshot> {
    await this.#pending;
    return this.#readExisting(threadId(id));
  }

  async resumeThread(id: ThreadId): Promise<SessionSnapshot> {
    return this.readThread(id);
  }

  async archiveThread(id: ThreadId): Promise<SessionSnapshot> {
    return this.#mutate(id, (snapshot) => {
      if (snapshot.thread.archivedAt) {
        throw new ForgeError('INVALID_TRANSITION', `Thread ${id} is already archived`);
      }
      return [{ type: 'thread.archived', data: {} }];
    });
  }

  async startTurn(id: ThreadId): Promise<TurnId> {
    const nextTurnId = this.#newTurnId();
    await this.#mutate(id, (snapshot) => {
      this.#assertActive(snapshot);
      return [
        { type: 'turn.created', turnId: nextTurnId, data: { state: 'queued' } },
        {
          type: 'turn.state_changed',
          turnId: nextTurnId,
          data: { from: 'queued', to: 'running' },
        },
      ];
    });
    return nextTurnId;
  }

  async transitionTurn(id: ThreadId, turn: TurnId, state: TurnState): Promise<SessionSnapshot> {
    return this.#mutate(id, (snapshot) => {
      this.#assertActive(snapshot);
      const record = this.#turn(snapshot, turn);
      assertTurnTransition(record.state, state);
      return [
        { type: 'turn.state_changed', turnId: turn, data: { from: record.state, to: state } },
      ];
    });
  }

  async steerTurn(id: ThreadId, turn: TurnId, content: string): Promise<ItemId> {
    const snapshot = await this.readThread(id);
    const state = this.#turn(snapshot, turn).state;
    if (state !== 'running' && state !== 'waiting_for_approval') {
      throw new ForgeError('INVALID_TRANSITION', `Cannot steer a turn in ${state} state`);
    }
    return this.appendCompletedItem(id, {
      turnId: turn,
      kind: 'UserMessage',
      payload: { content, steered: true },
    });
  }

  async cancelTurn(id: ThreadId, turn: TurnId): Promise<SessionSnapshot> {
    return this.transitionTurn(id, turn, 'cancelled');
  }

  async startStep(id: ThreadId, turn: TurnId, index: number, label?: string): Promise<StepId> {
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new ForgeError('INVALID_SESSION', 'Step index must be a non-negative integer');
    }
    const nextStepId = this.#newStepId();
    await this.#mutate(id, (snapshot) => {
      this.#assertRunningTurn(snapshot, turn);
      return [
        {
          type: 'step.started',
          turnId: turn,
          stepId: nextStepId,
          data: { index, ...(label === undefined ? {} : { label }) },
        },
      ];
    });
    return nextStepId;
  }

  async completeStep(id: ThreadId, turn: TurnId, step: StepId): Promise<SessionSnapshot> {
    return this.#mutate(id, () => [
      { type: 'step.completed', turnId: turn, stepId: step, data: {} },
    ]);
  }

  async failStep(
    id: ThreadId,
    turn: TurnId,
    step: StepId,
    message: string,
  ): Promise<SessionSnapshot> {
    return this.#mutate(id, () => [
      { type: 'step.failed', turnId: turn, stepId: step, data: { message } },
    ]);
  }

  async startItem<Kind extends ItemKind>(
    id: ThreadId,
    input: StartItemInput<Kind>,
  ): Promise<ItemId> {
    assertJsonValue(input.payload, `${input.kind} payload`);
    validateItemPayload(input.kind, input.payload);
    const nextItemId = this.#newItemId();
    await this.#mutate(id, (snapshot) => {
      this.#assertRunningTurn(snapshot, input.turnId);
      return [
        {
          type: 'item.started',
          turnId: input.turnId,
          itemId: nextItemId,
          ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
          data: { kind: input.kind, payload: input.payload },
        },
      ];
    });
    return nextItemId;
  }

  async appendItemDelta(id: ThreadId, item: ItemId, delta: JsonValue): Promise<SessionSnapshot> {
    assertJsonValue(delta, 'item delta');
    return this.#itemMutation(id, item, {
      type: 'item.delta',
      data: { delta },
    });
  }

  async completeItem(id: ThreadId, item: ItemId, result?: JsonValue): Promise<SessionSnapshot> {
    if (result !== undefined) assertJsonValue(result, 'item result');
    return this.#itemMutation(id, item, {
      type: 'item.completed',
      data: result === undefined ? {} : { result },
    });
  }

  async failItem(
    id: ThreadId,
    item: ItemId,
    message: string,
    code?: string,
  ): Promise<SessionSnapshot> {
    return this.#itemMutation(id, item, {
      type: 'item.failed',
      data: { message, ...(code === undefined ? {} : { code }) },
    });
  }

  async appendCompletedItem<Kind extends ItemKind>(
    id: ThreadId,
    input: StartItemInput<Kind>,
  ): Promise<ItemId> {
    assertJsonValue(input.payload, `${input.kind} payload`);
    validateItemPayload(input.kind, input.payload);
    const nextItemId = this.#newItemId();
    await this.#mutate(id, (snapshot) => {
      this.#assertRunningTurn(snapshot, input.turnId);
      const common = {
        turnId: input.turnId,
        itemId: nextItemId,
        ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
      };
      const started = {
        type: 'item.started',
        ...common,
        data: { kind: input.kind, payload: input.payload },
      } as NewEvent;
      const completed = { type: 'item.completed', ...common, data: {} } as NewEvent;
      return [started, completed];
    });
    return nextItemId;
  }

  async resolveApproval(
    id: ThreadId,
    approvalId: string,
    decision: 'allow' | 'deny',
  ): Promise<SessionSnapshot> {
    return this.#mutate(id, (snapshot) => {
      const item = snapshot.items.find(
        (candidate) =>
          candidate.kind === 'ApprovalRequest' && candidate.payload.approvalId === approvalId,
      );
      if (!item) throw new ForgeError('SESSION_NOT_FOUND', `Approval ${approvalId} was not found`);
      if (item.state !== 'started') {
        throw new ForgeError('INVALID_TRANSITION', `Approval ${approvalId} is already resolved`);
      }
      const turn = this.#turn(snapshot, item.turnId);
      const events: NewEvent[] = [
        {
          type: 'item.completed',
          turnId: item.turnId,
          itemId: item.id,
          ...(item.stepId === undefined ? {} : { stepId: item.stepId }),
          data: { result: { decision } },
        },
      ];
      if (turn.state === 'waiting_for_approval') {
        events.push({
          type: 'turn.state_changed',
          turnId: turn.id,
          data: { from: 'waiting_for_approval', to: 'running' },
        });
      }
      return events;
    });
  }

  async compactContext(
    id: ThreadId,
    turn: TurnId,
    summary: string,
    throughSequence: number,
  ): Promise<ItemId> {
    const snapshot = await this.readThread(id);
    if (throughSequence < 1 || throughSequence > snapshot.events.length) {
      throw new ForgeError('INVALID_SESSION', 'Compaction boundary is outside the session log');
    }
    return this.appendCompletedItem(id, {
      turnId: turn,
      kind: 'ContextCompaction',
      payload: { summary, throughSequence },
    });
  }

  async restoreCheckpoint(id: ThreadId, turn: TurnId, checkpointId: string): Promise<ItemId> {
    return this.appendCompletedItem(id, {
      turnId: turn,
      kind: 'CheckpointRestore',
      payload: { checkpointId },
    });
  }

  async forkThread(id: ThreadId, throughTurnId?: TurnId): Promise<SessionSnapshot> {
    return this.#exclusive(async () => {
      const source = await this.#readExisting(id);
      if (throughTurnId !== undefined && !source.turns.some((turn) => turn.id === throughTurnId)) {
        throw new ForgeError('SESSION_NOT_FOUND', `Turn ${throughTurnId} was not found`);
      }
      const cutoff =
        throughTurnId === undefined
          ? Number.POSITIVE_INFINITY
          : Math.max(
              ...source.events
                .filter((event) => 'turnId' in event && event.turnId === throughTurnId)
                .map((event) => event.sequence),
            );
      const target = this.#newThreadId();
      const turnIds = new Map<TurnId, TurnId>();
      const stepIds = new Map<StepId, StepId>();
      const itemIds = new Map<ItemId, ItemId>();
      const timestamp = this.#clock();
      const copied: SessionEvent[] = [
        this.#event(target, 1, {
          type: 'thread.created',
          data: {
            workspaceRoot: source.thread.workspaceRoot,
            configSnapshot: source.thread.configSnapshot,
            forkedFrom: { threadId: id, ...(throughTurnId ? { throughTurnId } : {}) },
          },
        }),
      ];
      for (const event of source.events.slice(1)) {
        if (event.sequence > cutoff || event.type === 'thread.archived') continue;
        const remapped = {
          ...event,
          eventId: this.#newEventId(),
          sequence: copied.length + 1,
          timestamp,
          threadId: target,
          ...('turnId' in event
            ? { turnId: this.#mapped(turnIds, event.turnId, () => this.#newTurnId()) }
            : {}),
          ...('stepId' in event && event.stepId !== undefined
            ? { stepId: this.#mapped(stepIds, event.stepId, () => this.#newStepId()) }
            : {}),
          ...('itemId' in event
            ? { itemId: this.#mapped(itemIds, event.itemId, () => this.#newItemId()) }
            : {}),
        } as SessionEvent;
        copied.push(remapped);
      }
      const snapshot = replaySession(copied);
      await this.#journal.append(target, copied);
      return snapshot;
    });
  }

  async #itemMutation(
    id: ThreadId,
    itemIdValue: ItemId,
    event: {
      readonly type: 'item.delta' | 'item.completed' | 'item.failed';
      readonly data: JsonObject;
    },
  ): Promise<SessionSnapshot> {
    return this.#mutate(id, (snapshot) => {
      const item = snapshot.items.find((candidate) => candidate.id === itemIdValue);
      if (!item) throw new ForgeError('SESSION_NOT_FOUND', `Item ${itemIdValue} was not found`);
      return [
        {
          ...event,
          turnId: item.turnId,
          itemId: item.id,
          ...(item.stepId === undefined ? {} : { stepId: item.stepId }),
        } as NewEvent,
      ];
    });
  }

  async #mutate(
    idValue: ThreadId,
    operation: (snapshot: SessionSnapshot) => readonly NewEvent[],
  ): Promise<SessionSnapshot> {
    return this.#exclusive(async () => {
      const id = threadId(idValue);
      const snapshot = await this.#readExisting(id);
      const additions = operation(snapshot).map((event, index) =>
        this.#event(id, snapshot.events.length + index + 1, event),
      );
      const next = replaySession([...snapshot.events, ...additions]);
      await this.#journal.append(id, additions);
      return next;
    });
  }

  #event(id: ThreadId, sequence: number, event: NewEvent): SessionEvent {
    return {
      schemaVersion: SESSION_SCHEMA_VERSION,
      eventId: this.#newEventId(),
      sequence,
      timestamp: this.#clock(),
      threadId: id,
      ...event,
    } as SessionEvent;
  }

  async #readExisting(id: ThreadId): Promise<SessionSnapshot> {
    const events = await this.#journal.read(threadId(id));
    if (events.length === 0)
      throw new ForgeError('SESSION_NOT_FOUND', `Thread ${id} was not found`);
    return replaySession(events);
  }

  #assertActive(snapshot: SessionSnapshot): void {
    if (snapshot.thread.archivedAt) {
      throw new ForgeError('INVALID_TRANSITION', `Thread ${snapshot.thread.id} is archived`);
    }
  }

  #assertRunningTurn(snapshot: SessionSnapshot, id: TurnId): void {
    this.#assertActive(snapshot);
    const turn = this.#turn(snapshot, id);
    if (turn.state !== 'running' && turn.state !== 'waiting_for_approval') {
      throw new ForgeError('INVALID_TRANSITION', `Turn ${id} is not active`, { state: turn.state });
    }
  }

  #turn(snapshot: SessionSnapshot, id: TurnId) {
    const turn = snapshot.turns.find((candidate) => candidate.id === id);
    if (!turn) throw new ForgeError('SESSION_NOT_FOUND', `Turn ${id} was not found`);
    return turn;
  }

  #mapped<Key, Value>(map: Map<Key, Value>, key: Key, create: () => Value): Value {
    const existing = map.get(key);
    if (existing !== undefined) return existing;
    const value = create();
    map.set(key, value);
    return value;
  }

  #newThreadId(): ThreadId {
    return threadId(this.#createId('thread'));
  }

  #newTurnId(): TurnId {
    return turnId(this.#createId('turn'));
  }

  #newStepId(): StepId {
    return stepId(this.#createId('step'));
  }

  #newItemId(): ItemId {
    return itemId(this.#createId('item'));
  }

  #newEventId(): SessionEventId {
    return sessionEventId(this.#createId('event'));
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(operation, operation);
    this.#pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class MemorySessionStore extends EventSessionStore {
  constructor(options?: SessionStoreOptions) {
    super(new MemorySessionJournal(), options);
  }
}

export class JsonlSessionStore extends EventSessionStore {
  constructor(directory: string, options?: SessionStoreOptions) {
    super(new JsonlSessionJournal(directory), options);
  }
}
