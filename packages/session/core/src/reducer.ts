import { ForgeError, type ItemId, type StepId, type TurnId } from '@forge/kernel-contracts';
import type {
  ItemRecord,
  SessionEvent,
  SessionSnapshot,
  StepRecord,
  ThreadRecord,
  TurnRecord,
  TurnState,
} from './protocol.js';

const TURN_TRANSITIONS: Readonly<Record<TurnState, readonly TurnState[]>> = {
  queued: ['running', 'cancelled'],
  running: ['waiting_for_approval', 'completed', 'failed', 'cancelled', 'limit_reached'],
  waiting_for_approval: ['running', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
  limit_reached: [],
};

function invariant(condition: unknown, message: string, event?: SessionEvent): asserts condition {
  if (!condition) {
    throw new ForgeError(
      'SESSION_CORRUPT',
      message,
      event ? { sequence: event.sequence } : undefined,
    );
  }
}

export function replaySession(events: readonly SessionEvent[]): SessionSnapshot {
  invariant(events.length > 0, 'A session log must contain at least one event');
  const first = events[0];
  invariant(first?.type === 'thread.created', 'The first event must create the thread', first);

  let thread: ThreadRecord | undefined;
  const turns = new Map<TurnId, TurnRecord>();
  const steps = new Map<StepId, StepRecord>();
  const items = new Map<ItemId, ItemRecord>();
  let previousSequence = 0;

  for (const event of events) {
    invariant(
      event.sequence === previousSequence + 1,
      'Session event sequence is not contiguous',
      event,
    );
    invariant(event.threadId === first.threadId, 'Session log contains another thread', event);
    previousSequence = event.sequence;

    if (event.type === 'thread.created') {
      invariant(thread === undefined, 'Thread was created more than once', event);
      thread = {
        id: event.threadId,
        workspaceRoot: event.data.workspaceRoot,
        configSnapshot: event.data.configSnapshot,
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
        ...(event.data.forkedFrom ? { forkedFrom: event.data.forkedFrom } : {}),
      };
      continue;
    }
    invariant(thread !== undefined, 'Event occurred before thread creation', event);
    thread = { ...thread, updatedAt: event.timestamp };

    if (event.type === 'thread.archived') {
      invariant(thread.archivedAt === undefined, 'Thread was archived more than once', event);
      thread = { ...thread, archivedAt: event.timestamp };
      continue;
    }
    if (event.type === 'turn.created') {
      invariant(!turns.has(event.turnId), 'Turn was created more than once', event);
      turns.set(event.turnId, {
        id: event.turnId,
        threadId: event.threadId,
        state: 'queued',
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
      });
      continue;
    }
    if (event.type === 'turn.state_changed') {
      const turn = turns.get(event.turnId);
      invariant(turn !== undefined, 'Turn state changed before creation', event);
      invariant(
        turn.state === event.data.from,
        'Turn transition has the wrong source state',
        event,
      );
      invariant(
        TURN_TRANSITIONS[turn.state].includes(event.data.to),
        `Invalid turn transition from ${turn.state} to ${event.data.to}`,
        event,
      );
      turns.set(event.turnId, { ...turn, state: event.data.to, updatedAt: event.timestamp });
      continue;
    }

    const turn = turns.get(event.turnId);
    invariant(turn !== undefined, 'Step or item refers to an unknown turn', event);
    if (event.type === 'step.started') {
      invariant(!steps.has(event.stepId), 'Step was started more than once', event);
      steps.set(event.stepId, {
        id: event.stepId,
        threadId: event.threadId,
        turnId: event.turnId,
        index: event.data.index,
        ...(event.data.label === undefined ? {} : { label: event.data.label }),
        state: 'running',
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
      });
      continue;
    }
    if (event.type === 'step.completed' || event.type === 'step.failed') {
      const step = steps.get(event.stepId);
      invariant(step !== undefined, 'Step ended before it started', event);
      invariant(step.turnId === event.turnId, 'Step event refers to the wrong turn', event);
      invariant(step.state === 'running', 'Step ended more than once', event);
      steps.set(event.stepId, {
        ...step,
        state: event.type === 'step.completed' ? 'completed' : 'failed',
        updatedAt: event.timestamp,
        ...(event.type === 'step.failed' ? { error: event.data.message } : {}),
      });
      continue;
    }
    if (event.type === 'item.started') {
      invariant(!items.has(event.itemId), 'Item was started more than once', event);
      if (event.stepId !== undefined) {
        const step = steps.get(event.stepId);
        invariant(step?.turnId === event.turnId, 'Item refers to an unknown step', event);
      }
      const record = {
        id: event.itemId,
        threadId: event.threadId,
        turnId: event.turnId,
        ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
        kind: event.data.kind,
        state: 'started',
        payload: event.data.payload,
        deltas: [],
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
        sequence: event.sequence,
      } as ItemRecord;
      items.set(event.itemId, record);
      continue;
    }
    const item = items.get(event.itemId);
    invariant(item !== undefined, 'Item lifecycle event occurred before item start', event);
    invariant(item.turnId === event.turnId, 'Item event refers to the wrong turn', event);
    invariant(item.stepId === event.stepId, 'Item event refers to the wrong step', event);
    invariant(item.state === 'started', 'Item changed after reaching a terminal state', event);
    if (event.type === 'item.delta') {
      items.set(event.itemId, {
        ...item,
        deltas: [...item.deltas, event.data.delta],
        updatedAt: event.timestamp,
      });
    } else if (event.type === 'item.completed') {
      items.set(event.itemId, {
        ...item,
        state: 'completed',
        updatedAt: event.timestamp,
        ...(event.data.result === undefined ? {} : { result: event.data.result }),
      });
    } else {
      items.set(event.itemId, {
        ...item,
        state: 'failed',
        updatedAt: event.timestamp,
        error: {
          message: event.data.message,
          ...(event.data.code === undefined ? {} : { code: event.data.code }),
        },
      });
    }
  }

  invariant(thread !== undefined, 'Thread record was not created');
  return {
    thread,
    turns: [...turns.values()],
    steps: [...steps.values()],
    items: [...items.values()],
    events: [...events],
  };
}

export function assertTurnTransition(from: TurnState, to: TurnState): void {
  if (!TURN_TRANSITIONS[from].includes(to)) {
    throw new ForgeError('INVALID_TRANSITION', `Cannot move a turn from ${from} to ${to}`, {
      from,
      to,
    });
  }
}
