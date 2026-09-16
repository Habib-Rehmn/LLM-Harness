import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  FORGE_API_VERSION,
  type ForgePlugin,
  pluginName,
  serviceToken,
} from '@forge/kernel-contracts';
import { TOOL_REGISTRY_SERVICE, type Tool } from '@forge/tools-core';

export interface TextReplacement {
  readonly oldText: string;
  readonly newText: string;
  readonly replaceAll?: boolean;
}

export interface PatchChange {
  readonly path: string;
  readonly expectedHash: string | null;
  readonly content?: string;
  readonly replacements?: readonly TextReplacement[];
  readonly delete?: boolean;
}

export interface ApplyPatchRequest {
  readonly turnId: string;
  readonly changes: readonly PatchChange[];
}

export interface FileChangeEvent {
  readonly turnId: string;
  readonly path: string;
  readonly kind: 'created' | 'updated' | 'deleted' | 'restored';
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly diff: string;
}

export interface PatchResult {
  readonly turnId: string;
  readonly changes: readonly FileChangeEvent[];
  readonly diff: string;
}

export interface RollbackResult extends PatchResult {
  readonly restored: number;
}

export class EditConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditConflictError';
  }
}

interface Image {
  readonly existed: boolean;
  readonly content?: Buffer;
  readonly mode?: number;
  readonly hash: string | null;
}

interface CheckpointEntry {
  readonly path: string;
  readonly before: Image;
  afterHash: string | null;
}

interface PreparedChange {
  readonly path: string;
  readonly absolute: string;
  readonly before: Image;
  readonly after?: Buffer;
  readonly kind: FileChangeEvent['kind'];
}

export class TransactionalEditor {
  readonly #root: string;
  readonly #checkpoints = new Map<string, Map<string, CheckpointEntry>>();
  readonly #listeners = new Set<(event: FileChangeEvent) => void>();

  private constructor(root: string) {
    this.#root = root;
  }

  get root(): string {
    return this.#root;
  }

  static async create(root: string): Promise<TransactionalEditor> {
    return new TransactionalEditor(await realpath(resolve(root)));
  }

  onFileChange(listener: (event: FileChangeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async hash(path: string): Promise<string | null> {
    const absolute = await this.#safePath(path, false);
    const image = await snapshot(absolute);
    return image.hash;
  }

  async applyPatch(request: ApplyPatchRequest): Promise<PatchResult> {
    if (!request.turnId || request.changes.length === 0) {
      throw new Error('A turn id and at least one patch change are required');
    }
    const duplicate = new Set<string>();
    const prepared: PreparedChange[] = [];
    for (const change of request.changes) {
      const path = normalizePath(change.path);
      if (duplicate.has(path)) throw new Error(`Patch contains duplicate path: ${path}`);
      duplicate.add(path);
      const absolute = await this.#safePath(path, !change.delete);
      const before = await snapshot(absolute);
      if (before.hash !== change.expectedHash) {
        throw new EditConflictError(
          `Conflict for ${path}: expected ${change.expectedHash ?? 'missing'}, found ${before.hash ?? 'missing'}`,
        );
      }
      validateUtf8(before.content, path);
      if (change.delete) {
        if (change.content !== undefined || change.replacements !== undefined) {
          throw new Error(`Delete change for ${path} cannot include content or replacements`);
        }
        if (!before.existed) throw new EditConflictError(`Cannot delete missing file: ${path}`);
        prepared.push({ path, absolute, before, kind: 'deleted' });
        continue;
      }
      if ((change.content === undefined) === (change.replacements === undefined)) {
        throw new Error(`Change for ${path} requires exactly one of content or replacements`);
      }
      const content =
        change.content ??
        applyReplacements(before.content?.toString('utf8') ?? '', change.replacements ?? []);
      const after = Buffer.from(content, 'utf8');
      prepared.push({
        path,
        absolute,
        before,
        after,
        kind: before.existed ? 'updated' : 'created',
      });
    }

    const applied: PreparedChange[] = [];
    try {
      for (const change of prepared) {
        await this.#assertUnchanged(change);
        if (change.after) await atomicWrite(change.absolute, change.after, change.before.mode);
        else await rm(change.absolute);
        applied.push(change);
      }
    } catch (error) {
      for (const change of applied.reverse()) await restoreImage(change.absolute, change.before);
      throw error;
    }

    const checkpoint = this.#checkpoints.get(request.turnId) ?? new Map<string, CheckpointEntry>();
    const events: FileChangeEvent[] = [];
    for (const change of prepared) {
      const afterHash = change.after ? digest(change.after) : null;
      const existing = checkpoint.get(change.path);
      if (existing) existing.afterHash = afterHash;
      else checkpoint.set(change.path, { path: change.path, before: change.before, afterHash });
      const event = eventFor(request.turnId, change, afterHash);
      events.push(event);
      for (const listener of this.#listeners) listener(event);
    }
    this.#checkpoints.set(request.turnId, checkpoint);
    return { turnId: request.turnId, changes: events, diff: joinDiffs(events) };
  }

  async rollback(turnId: string): Promise<RollbackResult> {
    const checkpoint = this.#checkpoints.get(turnId);
    if (!checkpoint) throw new Error(`Checkpoint not found for turn ${turnId}`);
    const entries = [...checkpoint.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    );
    for (const entry of entries) {
      const absolute = await this.#safePath(entry.path, entry.before.existed);
      const current = await snapshot(absolute);
      if (current.hash !== entry.afterHash) {
        throw new EditConflictError(
          `Cannot restore ${entry.path}; it changed after the checkpoint`,
        );
      }
    }
    const events: FileChangeEvent[] = [];
    for (const entry of entries) {
      const absolute = await this.#safePath(entry.path, entry.before.existed);
      const current = await snapshot(absolute);
      await restoreImage(absolute, entry.before);
      const restored: PreparedChange = {
        path: entry.path,
        absolute,
        before: current,
        ...(entry.before.content ? { after: entry.before.content } : {}),
        kind: 'restored',
      };
      const event = eventFor(turnId, restored, entry.before.hash);
      events.push(event);
      for (const listener of this.#listeners) listener(event);
    }
    this.#checkpoints.delete(turnId);
    return { turnId, restored: events.length, changes: events, diff: joinDiffs(events) };
  }

  async #assertUnchanged(change: PreparedChange): Promise<void> {
    const current = await snapshot(change.absolute);
    if (current.hash !== change.before.hash) {
      throw new EditConflictError(`${change.path} changed while applying the transaction`);
    }
    await this.#safePath(change.path, change.after !== undefined);
  }

  async #safePath(path: string, createParents: boolean): Promise<string> {
    const normalized = normalizePath(path);
    const absolute = resolve(this.#root, normalized);
    assertInside(this.#root, absolute);
    const parts = normalized.split('/');
    let current = this.#root;
    for (const part of parts.slice(0, -1)) {
      current = resolve(current, part);
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink())
          throw new Error(`Symlink path component is forbidden: ${path}`);
        if (!metadata.isDirectory()) throw new Error(`Path component is not a directory: ${path}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !createParents) throw error;
        await mkdir(current);
      }
    }
    try {
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) throw new Error(`Symlink target is forbidden: ${path}`);
      if (!metadata.isFile()) throw new Error(`Edit target is not a regular file: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = await realpath(dirname(absolute));
    assertInside(this.#root, parent);
    return absolute;
  }
}

function normalizePath(path: string): string {
  if (!path || isAbsolute(path) || path.includes('\0'))
    throw new Error('Edit path must be relative');
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized.split('/').some((part) => !part || part === '..' || part === '.')) {
    throw new Error('Edit path escapes the workspace');
  }
  return normalized;
}

function assertInside(root: string, candidate: string): void {
  const relation = relative(root, candidate);
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error('Edit path escapes the workspace');
  }
}

async function snapshot(path: string): Promise<Image> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error(`Edit target is not a regular file: ${path}`);
    const content = await readFile(path);
    return { existed: true, content, mode: metadata.mode & 0o777, hash: digest(content) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { existed: false, hash: null };
    throw error;
  }
}

function validateUtf8(content: Buffer | undefined, path: string): void {
  if (!content) return;
  if (content.includes(0)) throw new Error(`Binary file cannot be edited: ${path}`);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new Error(`File is not valid UTF-8: ${path}`);
  }
}

function applyReplacements(content: string, replacements: readonly TextReplacement[]): string {
  if (replacements.length === 0) throw new Error('At least one replacement is required');
  let result = content;
  for (const replacement of replacements) {
    if (!replacement.oldText) throw new Error('Replacement oldText cannot be empty');
    const occurrences = result.split(replacement.oldText).length - 1;
    if (occurrences === 0) throw new EditConflictError('Patch context was not found');
    if (!replacement.replaceAll && occurrences !== 1) {
      throw new EditConflictError('Patch context is ambiguous; provide more context or replaceAll');
    }
    result = replacement.replaceAll
      ? result.replaceAll(replacement.oldText, replacement.newText)
      : result.replace(replacement.oldText, replacement.newText);
  }
  return result;
}

async function atomicWrite(path: string, content: Buffer, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = resolve(dirname(path), `.${basename(path)}.forge-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', mode ?? 0o666);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function restoreImage(path: string, image: Image): Promise<void> {
  if (!image.existed) {
    await rm(path, { force: true });
    return;
  }
  await atomicWrite(path, image.content ?? Buffer.alloc(0), image.mode);
}

function digest(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function eventFor(
  turnId: string,
  change: PreparedChange,
  afterHash: string | null,
): FileChangeEvent {
  const before = change.before.content?.toString('utf8') ?? '';
  const after = change.after?.toString('utf8') ?? '';
  return {
    turnId,
    path: change.path,
    kind: change.kind,
    beforeHash: change.before.hash,
    afterHash,
    diff: unifiedDiff(
      change.path,
      before,
      after,
      change.before.existed,
      change.after !== undefined,
    ),
  };
}

function unifiedDiff(
  path: string,
  before: string,
  after: string,
  existed: boolean,
  exists: boolean,
): string {
  const oldLines = before ? before.replace(/\n$/, '').split('\n') : [];
  const newLines = after ? after.replace(/\n$/, '').split('\n') : [];
  return [
    `--- ${existed ? `a/${path}` : '/dev/null'}`,
    `+++ ${exists ? `b/${path}` : '/dev/null'}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n');
}

function joinDiffs(events: readonly FileChangeEvent[]): string {
  return events.map(({ diff }) => diff).join('\n');
}

export const EDITOR_SERVICE = serviceToken<TransactionalEditor>('forge.transactional-editor');

export function createEditorTools(editor: TransactionalEditor): readonly Tool[] {
  const common = {
    version: '1.0.0',
    capabilities: ['workspace.write'],
    risk: 'sensitive' as const,
    readOnly: false,
    idempotent: false,
    timeoutMs: 30_000,
    maxOutputBytes: 128_000,
    maxOutputLines: 4_000,
    origin: 'official-plugin' as const,
  };
  return [
    {
      definition: {
        ...common,
        name: 'editor.apply_patch',
        description:
          'Atomically create, update, or delete UTF-8 workspace files. Supply the hash returned by a repository read; use null only when creating a missing file.',
        inputSchema: {
          type: 'object',
          required: ['turnId', 'changes'],
          properties: {
            turnId: { type: 'string', minLength: 1 },
            changes: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['path', 'expectedHash'],
                properties: {
                  path: { type: 'string', minLength: 1 },
                  expectedHash: { type: ['string', 'null'] },
                  content: { type: 'string' },
                  delete: { type: 'boolean' },
                  replacements: {
                    type: 'array',
                    minItems: 1,
                    items: {
                      type: 'object',
                      required: ['oldText', 'newText'],
                      properties: {
                        oldText: { type: 'string', minLength: 1 },
                        newText: { type: 'string' },
                        replaceAll: { type: 'boolean' },
                      },
                      additionalProperties: false,
                    },
                  },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
      async execute(arguments_) {
        const result = await editor.applyPatch(arguments_ as unknown as ApplyPatchRequest);
        return { text: result.diff, data: { changed: result.changes.length } };
      },
    },
    {
      definition: {
        ...common,
        name: 'editor.rollback',
        description:
          'Restore every file changed by one turn, but only if none were modified after Forge edited them.',
        inputSchema: {
          type: 'object',
          required: ['turnId'],
          properties: { turnId: { type: 'string', minLength: 1 } },
          additionalProperties: false,
        },
      },
      async execute(arguments_) {
        const result = await editor.rollback(String(arguments_.turnId));
        return { text: result.diff, data: { restored: result.restored } };
      },
    },
  ];
}

export function createEditorPlugin(editor: TransactionalEditor): ForgePlugin {
  return {
    manifest: {
      apiVersion: FORGE_API_VERSION,
      name: pluginName('forge-editor-core'),
      version: '0.1.0',
      runtime: 'trusted',
      entrypoint: './lib/index.js',
      optional: { [TOOL_REGISTRY_SERVICE.id]: '^0.1.0' },
      provides: [EDITOR_SERVICE.id],
      permissions: { filesystem: { write: [editor.root] } },
    },
    setup(context) {
      context.provide(EDITOR_SERVICE, editor);
      const tools = context.optional(TOOL_REGISTRY_SERVICE);
      if (tools) for (const tool of createEditorTools(editor)) context.effect(tools.register(tool));
    },
  };
}
