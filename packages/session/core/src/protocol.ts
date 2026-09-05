import { readFileSync } from 'node:fs';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import {
  ForgeError,
  type ItemId,
  type SessionEventId,
  type StepId,
  type ThreadId,
  type TurnId,
  itemId,
  sessionEventId,
  stepId,
  threadId,
  turnId,
} from '@forge/kernel-contracts';

export const SESSION_SCHEMA_VERSION = 'forge.session/v1' as const;
export type SessionSchemaVersion = typeof SESSION_SCHEMA_VERSION;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type TurnState =
  | 'queued'
  | 'running'
  | 'waiting_for_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'limit_reached';
export type StepState = 'running' | 'completed' | 'failed';
export type ItemLifecycleState = 'started' | 'completed' | 'failed';
export type ItemKind =
  | 'UserMessage'
  | 'AssistantMessage'
  | 'ReasoningSummary'
  | 'PlanUpdate'
  | 'ToolCall'
  | 'ToolResult'
  | 'CommandExecution'
  | 'FileChange'
  | 'ApprovalRequest'
  | 'ContextCompaction'
  | 'CheckpointRestore'
  | 'Warning'
  | 'Error';

export interface ItemPayloads {
  readonly UserMessage: { readonly content: string; readonly steered?: boolean };
  readonly AssistantMessage: { readonly content: string };
  readonly ReasoningSummary: { readonly summary: string };
  readonly PlanUpdate: {
    readonly steps: readonly {
      readonly text: string;
      readonly status: 'pending' | 'in_progress' | 'completed';
    }[];
  };
  readonly ToolCall: {
    readonly callId: string;
    readonly name: string;
    readonly arguments: JsonObject;
  };
  readonly ToolResult: {
    readonly callId: string;
    readonly output: string;
    readonly isError?: boolean;
  };
  readonly CommandExecution: { readonly command: string; readonly cwd: string };
  readonly FileChange: {
    readonly path: string;
    readonly operation: 'create' | 'update' | 'delete' | 'rename';
  };
  readonly ApprovalRequest: {
    readonly approvalId: string;
    readonly reason: string;
    readonly decision?: 'allow' | 'deny';
  };
  readonly ContextCompaction: { readonly summary: string; readonly throughSequence: number };
  readonly CheckpointRestore: { readonly checkpointId: string };
  readonly Warning: { readonly message: string; readonly code?: string };
  readonly Error: { readonly message: string; readonly code?: string };
}

export interface SessionEventHeader {
  readonly schemaVersion: SessionSchemaVersion;
  readonly eventId: SessionEventId;
  readonly sequence: number;
  readonly timestamp: string;
  readonly threadId: ThreadId;
}

type Event<Type extends string, Data, Extra = object> = SessionEventHeader &
  Extra & {
    readonly type: Type;
    readonly data: Data;
  };

type TurnEvent<Type extends string, Data> = Event<Type, Data, { readonly turnId: TurnId }>;
type StepEvent<Type extends string, Data> = Event<
  Type,
  Data,
  { readonly turnId: TurnId; readonly stepId: StepId }
>;
type ItemEvent<Type extends string, Data> = Event<
  Type,
  Data,
  { readonly turnId: TurnId; readonly itemId: ItemId; readonly stepId?: StepId }
>;

export type SessionEvent =
  | Event<
      'thread.created',
      {
        readonly workspaceRoot: string;
        readonly configSnapshot: JsonObject;
        readonly forkedFrom?: { readonly threadId: ThreadId; readonly throughTurnId?: TurnId };
      }
    >
  | Event<'thread.archived', object>
  | TurnEvent<'turn.created', { readonly state: 'queued' }>
  | TurnEvent<'turn.state_changed', { readonly from: TurnState; readonly to: TurnState }>
  | StepEvent<'step.started', { readonly index: number; readonly label?: string }>
  | StepEvent<'step.completed', object>
  | StepEvent<'step.failed', { readonly message: string }>
  | ItemEvent<'item.started', { readonly kind: ItemKind; readonly payload: ItemPayloads[ItemKind] }>
  | ItemEvent<'item.delta', { readonly delta: JsonValue }>
  | ItemEvent<'item.completed', { readonly result?: JsonValue }>
  | ItemEvent<'item.failed', { readonly message: string; readonly code?: string }>;

export interface ThreadRecord {
  readonly id: ThreadId;
  readonly workspaceRoot: string;
  readonly configSnapshot: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
  readonly forkedFrom?: { readonly threadId: ThreadId; readonly throughTurnId?: TurnId };
}

export interface TurnRecord {
  readonly id: TurnId;
  readonly threadId: ThreadId;
  readonly state: TurnState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StepRecord {
  readonly id: StepId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly index: number;
  readonly label?: string;
  readonly state: StepState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error?: string;
}

export type ItemRecord<Kind extends ItemKind = ItemKind> = Kind extends ItemKind
  ? {
      readonly id: ItemId;
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly stepId?: StepId;
      readonly kind: Kind;
      readonly state: ItemLifecycleState;
      readonly payload: ItemPayloads[Kind];
      readonly deltas: readonly JsonValue[];
      readonly result?: JsonValue;
      readonly error?: { readonly message: string; readonly code?: string };
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly sequence: number;
    }
  : never;

export interface SessionSnapshot {
  readonly thread: ThreadRecord;
  readonly turns: readonly TurnRecord[];
  readonly steps: readonly StepRecord[];
  readonly items: readonly ItemRecord[];
  readonly events: readonly SessionEvent[];
}

const SCHEMA_URL = new URL('../../../../schemas/session-v1.schema.json', import.meta.url);

function createValidator(): ValidateFunction {
  const schema = JSON.parse(readFileSync(SCHEMA_URL, 'utf8')) as object;
  return new Ajv2020({ allErrors: true, strict: true, strictRequired: false }).compile(schema);
}

const validateSchema = createValidator();

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ');
}

export function parseSessionEvent(value: unknown, source = 'session event'): SessionEvent {
  if (!validateSchema(value)) {
    throw new ForgeError('SESSION_CORRUPT', `${source} does not match the session schema`, {
      errors: formatErrors(validateSchema.errors),
    });
  }
  const event = value as SessionEvent;
  threadId(event.threadId);
  sessionEventId(event.eventId);
  if ('turnId' in event) turnId(event.turnId);
  if ('stepId' in event && event.stepId !== undefined) stepId(event.stepId);
  if ('itemId' in event) itemId(event.itemId);
  assertJsonValue(event.data, `${source} data`);
  if (event.type === 'thread.created') assertSecretReferences(event.data.configSnapshot);
  if (event.type === 'item.started') validateItemPayload(event.data.kind, event.data.payload);
  return event;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, kind: ItemKind): void {
  if (typeof record[key] !== 'string') {
    throw new ForgeError('SESSION_CORRUPT', `${kind} payload requires string field ${key}`);
  }
}

export function validateItemPayload(kind: ItemKind, payload: unknown): void {
  if (!isRecord(payload))
    throw new ForgeError('SESSION_CORRUPT', `${kind} payload must be an object`);
  switch (kind) {
    case 'UserMessage':
    case 'AssistantMessage':
      requireString(payload, 'content', kind);
      break;
    case 'ReasoningSummary':
    case 'ContextCompaction':
      requireString(payload, 'summary', kind);
      if (
        kind === 'ContextCompaction' &&
        (!Number.isSafeInteger(payload.throughSequence) || Number(payload.throughSequence) < 1)
      ) {
        throw new ForgeError('SESSION_CORRUPT', 'ContextCompaction requires a valid boundary');
      }
      break;
    case 'CheckpointRestore':
      requireString(payload, 'checkpointId', kind);
      break;
    case 'PlanUpdate':
      if (!Array.isArray(payload.steps)) {
        throw new ForgeError('SESSION_CORRUPT', 'PlanUpdate payload requires steps');
      }
      break;
    case 'ToolCall':
      requireString(payload, 'callId', kind);
      requireString(payload, 'name', kind);
      if (!isRecord(payload.arguments)) {
        throw new ForgeError('SESSION_CORRUPT', 'ToolCall payload requires object arguments');
      }
      break;
    case 'ToolResult':
      requireString(payload, 'callId', kind);
      requireString(payload, 'output', kind);
      break;
    case 'CommandExecution':
      requireString(payload, 'command', kind);
      requireString(payload, 'cwd', kind);
      break;
    case 'FileChange':
      requireString(payload, 'path', kind);
      requireString(payload, 'operation', kind);
      break;
    case 'ApprovalRequest':
      requireString(payload, 'approvalId', kind);
      requireString(payload, 'reason', kind);
      break;
    case 'Warning':
    case 'Error':
      requireString(payload, 'message', kind);
      break;
  }
}

const SENSITIVE_CONFIG_KEY = /^(?:api[-_]?key|access[-_]?token|password|secret|token)$/i;

export function assertSecretReferences(config: JsonObject): void {
  function visit(value: JsonValue): void {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_CONFIG_KEY.test(key)) {
        if (!isRecord(child) || typeof child.secretRef !== 'string') {
          throw new ForgeError(
            'INVALID_SESSION',
            `Configuration field ${key} must contain a secretRef, not a resolved secret`,
          );
        }
      }
      visit(child as JsonValue);
    }
  }
  visit(config);
}

export function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
  const seen = new WeakSet<object>();
  function visit(candidate: unknown): boolean {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
      return true;
    }
    if (typeof candidate === 'number') return Number.isFinite(candidate);
    if (typeof candidate !== 'object') return false;
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    if (Array.isArray(candidate)) return candidate.every(visit);
    const prototype = Object.getPrototypeOf(candidate) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(candidate).every(visit);
  }
  if (!visit(value)) {
    throw new ForgeError('INVALID_SESSION', `${label} must be a finite, acyclic JSON value`);
  }
}
