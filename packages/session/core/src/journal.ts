import { mkdir, open, readdir, readFile, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { ForgeError, type ThreadId, threadId } from '@forge/kernel-contracts';
import { parseSessionEvent, type SessionEvent } from './protocol.js';

export interface SessionJournal {
  listThreadIds(): Promise<readonly ThreadId[]>;
  read(thread: ThreadId): Promise<readonly SessionEvent[]>;
  append(thread: ThreadId, events: readonly SessionEvent[]): Promise<void>;
}

export class MemorySessionJournal implements SessionJournal {
  readonly #logs = new Map<ThreadId, SessionEvent[]>();

  async listThreadIds(): Promise<readonly ThreadId[]> {
    return [...this.#logs.keys()].sort();
  }

  async read(id: ThreadId): Promise<readonly SessionEvent[]> {
    return [...(this.#logs.get(id) ?? [])];
  }

  async append(id: ThreadId, events: readonly SessionEvent[]): Promise<void> {
    this.#logs.set(id, [...(this.#logs.get(id) ?? []), ...events]);
  }
}

export interface JsonlSessionJournalOptions {
  readonly syncWrites?: boolean;
}

export class JsonlSessionJournal implements SessionJournal {
  readonly #directory: string;
  readonly #syncWrites: boolean;

  constructor(directory: string, options: JsonlSessionJournalOptions = {}) {
    this.#directory = directory;
    this.#syncWrites = options.syncWrites ?? true;
  }

  async listThreadIds(): Promise<readonly ThreadId[]> {
    await mkdir(this.#directory, { recursive: true });
    const entries = await readdir(this.#directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => threadId(entry.name.slice(0, -'.jsonl'.length)))
      .sort();
  }

  async read(id: ThreadId): Promise<readonly SessionEvent[]> {
    const path = this.#path(id);
    let contents: string;
    try {
      contents = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const boundary = contents.lastIndexOf('\n') + 1;
    if (boundary < contents.length) {
      await truncate(path, boundary);
      contents = contents.slice(0, boundary);
    }
    const lines = contents.split('\n').filter((line) => line.length > 0);
    return lines.map((line, index) => {
      try {
        return parseSessionEvent(JSON.parse(line), `${path}:${index + 1}`);
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new ForgeError(
            'SESSION_CORRUPT',
            `Invalid JSON at ${path}:${index + 1}`,
            undefined,
            {
              cause: error,
            },
          );
        }
        throw error;
      }
    });
  }

  async append(id: ThreadId, events: readonly SessionEvent[]): Promise<void> {
    if (events.length === 0) return;
    await mkdir(this.#directory, { recursive: true });
    const handle = await open(this.#path(id), 'a');
    try {
      await handle.writeFile(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
      if (this.#syncWrites) await handle.sync();
    } finally {
      await handle.close();
    }
  }

  #path(id: ThreadId): string {
    return join(this.#directory, `${threadId(id)}.jsonl`);
  }
}
