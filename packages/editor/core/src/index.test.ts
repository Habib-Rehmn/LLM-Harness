import { chmod, lstat, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EditConflictError, TransactionalEditor } from './index.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'forge-editor-'));
  await writeFile(join(directory, 'existing.txt'), 'before\n');
  await chmod(join(directory, 'existing.txt'), 0o744);
  return { directory, editor: await TransactionalEditor.create(directory) };
}

describe('transactional editor', () => {
  it('creates, updates, deletes, emits an aggregate diff, and preserves metadata', async () => {
    const { directory, editor } = await fixture();
    const existingHash = await editor.hash('existing.txt');
    await writeFile(join(directory, 'delete.txt'), 'remove me\n');
    const deleteHash = await editor.hash('delete.txt');
    const events: string[] = [];
    editor.onFileChange((event) => events.push(`${event.kind}:${event.path}`));
    const result = await editor.applyPatch({
      turnId: 'turn-1',
      changes: [
        {
          path: 'existing.txt',
          expectedHash: existingHash,
          replacements: [{ oldText: 'before', newText: 'after' }],
        },
        { path: 'nested/new.txt', expectedHash: null, content: 'created 🌍\n' },
        { path: 'delete.txt', expectedHash: deleteHash, delete: true },
      ],
    });
    expect(await readFile(join(directory, 'existing.txt'), 'utf8')).toBe('after\n');
    expect((await lstat(join(directory, 'existing.txt'))).mode & 0o777).toBe(0o744);
    expect(await readFile(join(directory, 'nested/new.txt'), 'utf8')).toBe('created 🌍\n');
    expect(await editor.hash('delete.txt')).toBeNull();
    expect(events).toEqual([
      'updated:existing.txt',
      'created:nested/new.txt',
      'deleted:delete.txt',
    ]);
    expect(result.diff).toContain('--- a/existing.txt');
    expect(result.diff).toContain('+++ b/nested/new.txt');
    expect(result.diff).toContain('+++ /dev/null');
  });

  it('rejects stale hashes, ambiguous patches, traversal, symlinks, and invalid UTF-8', async () => {
    const { directory, editor } = await fixture();
    await expect(
      editor.applyPatch({
        turnId: 'stale',
        changes: [{ path: 'existing.txt', expectedHash: 'stale', content: 'bad' }],
      }),
    ).rejects.toBeInstanceOf(EditConflictError);
    const hash = await editor.hash('existing.txt');
    await writeFile(join(directory, 'existing.txt'), 'same same');
    const repeatedHash = await editor.hash('existing.txt');
    await expect(
      editor.applyPatch({
        turnId: 'ambiguous',
        changes: [
          {
            path: 'existing.txt',
            expectedHash: repeatedHash,
            replacements: [{ oldText: 'same', newText: 'new' }],
          },
        ],
      }),
    ).rejects.toThrow('ambiguous');
    await expect(editor.hash('../outside.txt')).rejects.toThrow('escapes');
    await mkdir(join(directory, 'real'));
    await symlink(join(directory, 'real'), join(directory, 'linked'));
    await expect(editor.hash('linked/file.txt')).rejects.toThrow('Symlink');
    await writeFile(join(directory, 'binary.txt'), Buffer.from([0xff, 0xfe]));
    const binaryHash = await editor.hash('binary.txt');
    await expect(
      editor.applyPatch({
        turnId: 'binary',
        changes: [{ path: 'binary.txt', expectedHash: binaryHash, content: 'text' }],
      }),
    ).rejects.toThrow('UTF-8');
    expect(hash).not.toBeNull();
  });

  it('rolls back a turn but never overwrites a later direct edit', async () => {
    const { directory, editor } = await fixture();
    const hash = await editor.hash('existing.txt');
    await editor.applyPatch({
      turnId: 'rollback',
      changes: [{ path: 'existing.txt', expectedHash: hash, content: 'changed\n' }],
    });
    const rollback = await editor.rollback('rollback');
    expect(rollback.restored).toBe(1);
    expect(await readFile(join(directory, 'existing.txt'), 'utf8')).toBe('before\n');

    const restoredHash = await editor.hash('existing.txt');
    await editor.applyPatch({
      turnId: 'conflicted-rollback',
      changes: [{ path: 'existing.txt', expectedHash: restoredHash, content: 'agent\n' }],
    });
    await writeFile(join(directory, 'existing.txt'), 'human\n');
    await expect(editor.rollback('conflicted-rollback')).rejects.toBeInstanceOf(EditConflictError);
    expect(await readFile(join(directory, 'existing.txt'), 'utf8')).toBe('human\n');
  });
});
