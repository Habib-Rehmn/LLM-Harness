import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  FORGE_API_VERSION,
  type ForgePlugin,
  pluginName,
  serviceToken,
} from '@forge/kernel-contracts';

export type ContextLane = 'instructions' | 'memory' | 'summary' | 'recent' | 'artifacts';

export interface ContextLaneItem {
  readonly id: string;
  readonly lane: ContextLane;
  readonly content: string;
  readonly priority: number;
  readonly provenance: string;
}

export interface ContextComposition {
  readonly text: string;
  readonly included: readonly string[];
  readonly omitted: readonly string[];
  readonly laneTokens: Readonly<Record<ContextLane, number>>;
  readonly estimatedTokens: number;
}

const LANE_ORDER: readonly ContextLane[] = [
  'instructions',
  'memory',
  'summary',
  'recent',
  'artifacts',
];

export class ContextLaneManager {
  compose(items: readonly ContextLaneItem[], tokenBudget: number): ContextComposition {
    if (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0) {
      throw new Error('Context token budget must be a positive integer');
    }
    const laneTokens: Record<ContextLane, number> = {
      instructions: 0,
      memory: 0,
      summary: 0,
      recent: 0,
      artifacts: 0,
    };
    const included: string[] = [];
    const omitted: string[] = [];
    const chunks: string[] = [];
    let remaining = tokenBudget;
    for (const lane of LANE_ORDER) {
      const candidates = items
        .filter((item) => item.lane === lane)
        .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
      for (const item of candidates) {
        const framed = `## ${lane}:${item.id}\n${item.content}`;
        const tokens = estimateTokens(framed);
        if (tokens > remaining) {
          omitted.push(item.id);
          continue;
        }
        chunks.push(framed);
        included.push(item.id);
        laneTokens[lane] += tokens;
        remaining -= tokens;
      }
    }
    return Object.freeze({
      text: chunks.join('\n\n'),
      included: Object.freeze(included),
      omitted: Object.freeze(omitted),
      laneTokens: Object.freeze(laneTokens),
      estimatedTokens: tokenBudget - remaining,
    });
  }
}

export interface ArtifactMetadata {
  readonly id: string;
  readonly kind: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly source: string;
  readonly createdAt: string;
}

export class ArtifactStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async put(input: {
    readonly kind: string;
    readonly content: string | Uint8Array;
    readonly mimeType?: string;
    readonly source: string;
  }): Promise<ArtifactMetadata> {
    const content =
      typeof input.content === 'string' ? Buffer.from(input.content) : Buffer.from(input.content);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const id = `sha256-${sha256}`;
    await mkdir(this.#root, { recursive: true });
    await writeFile(resolve(this.#root, `${id}.bin`), content, { flag: 'wx' }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    const metadata: ArtifactMetadata = Object.freeze({
      id,
      kind: input.kind,
      mimeType: input.mimeType ?? 'text/plain; charset=utf-8',
      sizeBytes: content.length,
      sha256,
      source: input.source,
      createdAt: new Date().toISOString(),
    });
    await appendFile(resolve(this.#root, 'index.jsonl'), `${JSON.stringify(metadata)}\n`, 'utf8');
    return metadata;
  }

  async get(id: string): Promise<Buffer> {
    if (!/^sha256-[a-f0-9]{64}$/.test(id)) throw new Error('Invalid artifact id');
    return readFile(resolve(this.#root, `${id}.bin`));
  }
}

export interface TrimmedOutput {
  readonly text: string;
  readonly originalBytes: number;
  readonly truncated: boolean;
  readonly artifact?: ArtifactMetadata;
}

export class OutputTrimmer {
  readonly #artifacts: ArtifactStore;

  constructor(artifacts: ArtifactStore) {
    this.#artifacts = artifacts;
  }

  async trim(text: string, maximumBytes: number, source: string): Promise<TrimmedOutput> {
    const originalBytes = Buffer.byteLength(text);
    if (originalBytes <= maximumBytes) return { text, originalBytes, truncated: false };
    const artifact = await this.#artifacts.put({ kind: 'full-output', content: text, source });
    const marker = '\n… full output stored as an artifact …\n';
    const budget = Math.max(0, maximumBytes - Buffer.byteLength(marker));
    const head = takeUtf8(text, Math.ceil(budget / 2), false);
    const tail = takeUtf8(text, Math.floor(budget / 2), true);
    return { text: `${head}${marker}${tail}`, originalBytes, truncated: true, artifact };
  }
}

export interface ConversationEntry {
  readonly sequence: number;
  readonly role: 'user' | 'assistant' | 'tool' | 'system';
  readonly content: string;
  readonly tokens: number;
  readonly decision?: string;
  readonly testState?: string;
}

export interface CompactionSnapshot {
  readonly id: string;
  readonly throughSequence: number;
  readonly summary: string;
  readonly decisions: readonly string[];
  readonly testState?: string;
  readonly sourceSequences: readonly number[];
  readonly createdAt: string;
}

export interface CompactionPolicy {
  readonly minimumEntries: number;
  readonly minimumTokens: number;
  readonly retainRecent: number;
  readonly maximumPerHour: number;
}

export class StructuredCompactor {
  readonly #policy: CompactionPolicy;
  readonly #timestamps: number[] = [];

  constructor(policy: Partial<CompactionPolicy> = {}) {
    this.#policy = {
      minimumEntries: policy.minimumEntries ?? 12,
      minimumTokens: policy.minimumTokens ?? 2_000,
      retainRecent: policy.retainRecent ?? 6,
      maximumPerHour: policy.maximumPerHour ?? 4,
    };
  }

  compact(entries: readonly ConversationEntry[], now = Date.now()): CompactionSnapshot | undefined {
    const eligible = entries.slice(0, Math.max(0, entries.length - this.#policy.retainRecent));
    if (
      eligible.length < this.#policy.minimumEntries ||
      eligible.reduce((sum, entry) => sum + entry.tokens, 0) < this.#policy.minimumTokens
    ) {
      return undefined;
    }
    while (this.#timestamps[0] !== undefined && this.#timestamps[0] <= now - 3_600_000) {
      this.#timestamps.shift();
    }
    if (this.#timestamps.length >= this.#policy.maximumPerHour) return undefined;
    this.#timestamps.push(now);
    const decisions = [
      ...new Set(eligible.flatMap((entry) => (entry.decision ? [entry.decision] : []))),
    ];
    const testState = eligible.findLast((entry) => entry.testState)?.testState;
    const summary = eligible
      .filter((entry) => entry.role !== 'tool')
      .map((entry) => `${entry.role}: ${compactLine(entry.content)}`)
      .join('\n');
    const throughSequence = eligible.at(-1)?.sequence;
    if (throughSequence === undefined) return undefined;
    return Object.freeze({
      id: randomUUID(),
      throughSequence,
      summary,
      decisions: Object.freeze(decisions),
      ...(testState ? { testState } : {}),
      sourceSequences: Object.freeze(eligible.map(({ sequence }) => sequence)),
      createdAt: new Date(now).toISOString(),
    });
  }

  resume(
    snapshot: CompactionSnapshot,
    recent: readonly ConversationEntry[],
  ): readonly ContextLaneItem[] {
    return [
      {
        id: `compaction-${snapshot.id}`,
        lane: 'summary',
        priority: 100,
        provenance: `sequences:${snapshot.sourceSequences.join(',')}`,
        content: [
          snapshot.summary,
          `Decisions: ${snapshot.decisions.join('; ') || 'none'}`,
          `Test state: ${snapshot.testState ?? 'unknown'}`,
        ].join('\n'),
      },
      ...recent
        .filter((entry) => entry.sequence > snapshot.throughSequence)
        .map((entry) => ({
          id: `entry-${entry.sequence}`,
          lane: 'recent' as const,
          priority: entry.sequence,
          provenance: `sequence:${entry.sequence}`,
          content: `${entry.role}: ${entry.content}`,
        })),
    ];
  }
}

export interface MemoryProvenance {
  readonly source: string;
  readonly workspaceId: string;
  readonly threadId?: string;
  readonly sequence?: number;
}

export interface ProjectMemoryRecord {
  readonly id: string;
  readonly topic: string;
  readonly content: string;
  readonly provenance: MemoryProvenance;
  readonly createdAt: string;
  readonly supersedes?: string;
}

export class ProjectMemoryStore {
  readonly #path: string;
  readonly #records: ProjectMemoryRecord[] = [];
  #loaded = false;

  constructor(path: string) {
    this.#path = resolve(path);
  }

  async remember(
    input: Omit<ProjectMemoryRecord, 'id' | 'createdAt' | 'supersedes'>,
  ): Promise<ProjectMemoryRecord> {
    await this.#load();
    const topic = input.topic.trim();
    const content = input.content.trim();
    if (!topic || !content) throw new Error('Memory topic and content are required');
    if (content.length > 1_000) throw new Error('Project memory must remain concise');
    const previous = this.#records.findLast(
      (record) =>
        record.topic === topic && record.provenance.workspaceId === input.provenance.workspaceId,
    );
    if (previous?.content === content) return previous;
    const record: ProjectMemoryRecord = Object.freeze({
      id: randomUUID(),
      topic,
      content,
      provenance: Object.freeze({ ...input.provenance }),
      createdAt: new Date().toISOString(),
      ...(previous ? { supersedes: previous.id } : {}),
    });
    this.#records.push(record);
    await mkdir(resolve(this.#path, '..'), { recursive: true });
    await appendFile(this.#path, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  async retrieve(
    query: string,
    workspaceId: string,
    maximum = 8,
  ): Promise<readonly ProjectMemoryRecord[]> {
    await this.#load();
    const terms = words(query);
    const superseded = new Set(
      this.#records.flatMap((record) => (record.supersedes ? [record.supersedes] : [])),
    );
    return this.#records
      .filter(
        (record) => record.provenance.workspaceId === workspaceId && !superseded.has(record.id),
      )
      .map((record, index) => ({
        record,
        score:
          words(`${record.topic} ${record.content}`).filter((word) => terms.includes(word)).length *
            100 +
          index,
      }))
      .filter(({ score }) => score > 0 || terms.length === 0)
      .sort(
        (left, right) => right.score - left.score || left.record.id.localeCompare(right.record.id),
      )
      .slice(0, maximum)
      .map(({ record }) => record);
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const content = await readFile(this.#path, 'utf8');
      for (const line of content.split('\n').filter(Boolean)) {
        this.#records.push(Object.freeze(JSON.parse(line) as ProjectMemoryRecord));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export type TraceEventType =
  | 'trace.started'
  | 'tokens'
  | 'tool'
  | 'approval'
  | 'context'
  | 'error'
  | 'trace.completed';

export interface TraceEvent {
  readonly traceId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: TraceEventType;
  readonly data: Readonly<Record<string, unknown>>;
  readonly sideEffect: boolean;
}

export interface TraceInspection {
  readonly traceId: string;
  readonly eventCount: number;
  readonly errors: number;
  readonly toolCalls: number;
  readonly approvals: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export class TraceStore {
  readonly #path: string;
  readonly #events = new Map<string, TraceEvent[]>();
  #loaded = false;

  constructor(path: string) {
    this.#path = resolve(path);
  }

  async record(
    traceId: string,
    type: TraceEventType,
    data: Readonly<Record<string, unknown>>,
    sideEffect = false,
  ): Promise<TraceEvent> {
    await this.#load();
    const events = this.#events.get(traceId) ?? [];
    const event: TraceEvent = Object.freeze({
      traceId,
      sequence: events.length + 1,
      timestamp: new Date().toISOString(),
      type,
      data: Object.freeze(structuredClone(data)),
      sideEffect,
    });
    events.push(event);
    this.#events.set(traceId, events);
    await mkdir(resolve(this.#path, '..'), { recursive: true });
    await appendFile(this.#path, `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  }

  async inspect(traceId: string): Promise<TraceInspection> {
    await this.#load();
    const events = this.#events.get(traceId) ?? [];
    return {
      traceId,
      eventCount: events.length,
      errors: events.filter(({ type }) => type === 'error').length,
      toolCalls: events.filter(({ type }) => type === 'tool').length,
      approvals: events.filter(({ type }) => type === 'approval').length,
      inputTokens: sumField(events, 'inputTokens'),
      outputTokens: sumField(events, 'outputTokens'),
    };
  }

  async replay(
    traceId: string,
  ): Promise<readonly { readonly event: TraceEvent; readonly executed: false }[]> {
    await this.#load();
    return Object.freeze(
      (this.#events.get(traceId) ?? []).map((event) =>
        Object.freeze({ event, executed: false as const }),
      ),
    );
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const content = await readFile(this.#path, 'utf8');
      for (const line of content.split('\n').filter(Boolean)) {
        const event = Object.freeze(JSON.parse(line) as TraceEvent);
        const events = this.#events.get(event.traceId) ?? [];
        events.push(event);
        this.#events.set(event.traceId, events);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function sumField(events: readonly TraceEvent[], field: string): number {
  return events.reduce((sum, event) => {
    const value = event.data[field];
    return sum + (typeof value === 'number' ? value : 0);
  }, 0);
}

function compactLine(content: string): string {
  return Array.from(content.replace(/\s+/g, ' ').trim()).slice(0, 240).join('');
}

function words(value: string): readonly string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter(Boolean);
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function takeUtf8(value: string, maximum: number, fromEnd: boolean): string {
  const characters = Array.from(value);
  if (fromEnd) characters.reverse();
  const selected: string[] = [];
  let bytes = 0;
  for (const character of characters) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maximum) break;
    selected.push(character);
    bytes += size;
  }
  if (fromEnd) selected.reverse();
  return selected.join('');
}

export interface MemoryRuntime {
  readonly lanes: ContextLaneManager;
  readonly artifacts: ArtifactStore;
  readonly trimmer: OutputTrimmer;
  readonly compactor: StructuredCompactor;
  readonly memory: ProjectMemoryStore;
  readonly traces: TraceStore;
}

export const MEMORY_RUNTIME_SERVICE = serviceToken<MemoryRuntime>('forge.memory-runtime');

export function createMemoryPlugin(root: string): ForgePlugin {
  return {
    manifest: {
      apiVersion: FORGE_API_VERSION,
      name: pluginName('forge-memory-core'),
      version: '0.1.0',
      runtime: 'trusted',
      entrypoint: './lib/index.js',
      provides: [MEMORY_RUNTIME_SERVICE.id],
      permissions: { filesystem: { read: [root], write: [root] } },
    },
    setup(context) {
      const artifacts = new ArtifactStore(resolve(root, 'artifacts'));
      context.provide(MEMORY_RUNTIME_SERVICE, {
        lanes: new ContextLaneManager(),
        artifacts,
        trimmer: new OutputTrimmer(artifacts),
        compactor: new StructuredCompactor(),
        memory: new ProjectMemoryStore(resolve(root, 'memory.jsonl')),
        traces: new TraceStore(resolve(root, 'traces.jsonl')),
      });
    },
  };
}
