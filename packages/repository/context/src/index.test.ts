import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolPipeline, ToolRegistry } from '@forge/tools-core';
import {
  ContextAssembler,
  RepositoryContext,
  createRepositoryTools,
  type ContextProvider,
} from './index.js';

async function fixture(): Promise<{ directory: string; repository: RepositoryContext }> {
  const directory = await mkdtemp(join(tmpdir(), 'forge-repository-'));
  await mkdir(join(directory, 'src'), { recursive: true });
  await mkdir(join(directory, 'cache'), { recursive: true });
  await mkdir(join(directory, 'generated'), { recursive: true });
  await mkdir(join(directory, 'node_modules/pkg'), { recursive: true });
  await writeFile(join(directory, '.gitignore'), '*.log\ncache/\n');
  await writeFile(join(directory, 'README.md'), '# Demo\nA parser project.\n');
  await writeFile(
    join(directory, 'src/main.ts'),
    "import { parseValue } from './parser.js';\nexport function runParser() { return parseValue('ok'); }\n",
  );
  await writeFile(
    join(directory, 'src/parser.ts'),
    'export interface Parsed { value: string }\nexport function parseValue(value: string): Parsed { return { value }; }\n',
  );
  await writeFile(join(directory, 'src/debug.log'), 'secret log');
  await writeFile(join(directory, 'cache/state.txt'), 'cache');
  await writeFile(join(directory, 'generated/client.ts'), 'export const generated = true;');
  await writeFile(join(directory, 'node_modules/pkg/index.js'), 'module.exports = {};');
  await writeFile(join(directory, '.env'), 'TOKEN=do-not-read');
  await writeFile(join(directory, 'private.pem'), 'private-key');
  await writeFile(join(directory, 'image.dat'), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(directory, 'large.txt'), 'x'.repeat(200));
  const outside = join(directory, '..', `outside-${Date.now()}.txt`);
  await writeFile(outside, 'outside secret');
  await symlink(outside, join(directory, 'linked-secret.txt'));
  return {
    directory,
    repository: new RepositoryContext({
      roots: [{ id: 'demo', path: directory }],
      ignore: ['generated/**'],
      maxFileBytes: 150,
      maxReadBytes: 80,
    }),
  };
}

describe('repository context', () => {
  it('inventories text while excluding ignores, secrets, binaries, large files, and symlinks', async () => {
    const { repository } = await fixture();
    const files = await repository.refresh();
    expect(files.map(({ path }) => path)).toEqual([
      '.gitignore',
      'README.md',
      'src/main.ts',
      'src/parser.ts',
    ]);
    expect(files.find(({ path }) => path === 'src/parser.ts')).toMatchObject({
      language: 'typescript',
      symbols: [
        expect.objectContaining({ name: 'Parsed', kind: 'interface', line: 1 }),
        expect.objectContaining({ name: 'parseValue', kind: 'function', line: 2 }),
      ],
    });
  });

  it('supports deterministic glob, text search, and bounded reads', async () => {
    const { repository } = await fixture();
    expect((await repository.glob('**/*.ts')).map(({ path }) => path)).toEqual([
      'src/main.ts',
      'src/parser.ts',
    ]);
    expect(await repository.searchText('parseValue')).toEqual([
      expect.objectContaining({ rootId: 'demo', path: 'src/main.ts', line: 1, column: 10 }),
      expect.objectContaining({ rootId: 'demo', path: 'src/main.ts', line: 2 }),
      expect.objectContaining({ rootId: 'demo', path: 'src/parser.ts', line: 2 }),
    ]);
    expect(
      await repository.read('demo', 'src/parser.ts', { startLine: 2, endLine: 2 }),
    ).toMatchObject({
      startLine: 2,
      endLine: 2,
      content: 'export function parseValue(value: string): Parsed { return { value }; }',
      truncated: false,
    });
    await expect(repository.read('demo', '../.env')).rejects.toThrow('escapes its root');
    await expect(repository.read('demo', '.env')).rejects.toThrow('unavailable or excluded');
  });

  it('ranks symbols deterministically within a fixed map budget and invalidates changes', async () => {
    const { directory, repository } = await fixture();
    const initial = await repository.refresh();
    const initialHash = initial.find(({ path }) => path === 'src/parser.ts')?.hash;
    const map = await repository.map('change parseValue parser', 80);
    expect(map.files[0]).toBe('demo:src/parser.ts');
    expect(map.content).toContain('parseValue');
    expect(map.estimatedTokens).toBeLessThanOrEqual(80);

    await writeFile(
      join(directory, 'src/parser.ts'),
      'export function parseValue(next: string) { return next.toUpperCase(); }\n',
    );
    const refreshed = await repository.refresh();
    expect(refreshed.find(({ path }) => path === 'src/parser.ts')?.hash).not.toBe(initialHash);
    repository.invalidate([{ rootId: 'demo', path: 'src/parser.ts' }]);
    expect(repository.inventory().map(({ path }) => path)).not.toContain('src/parser.ts');
  });

  it('assembles scoped provider sections by priority without exceeding the budget', async () => {
    const { repository } = await fixture();
    const assembler = new ContextAssembler();
    assembler.register(repository);
    const instructions: ContextProvider = {
      id: 'instructions',
      async provide() {
        return {
          id: 'instructions',
          title: 'Project instructions',
          content: 'Always run tests.',
          priority: 100,
          estimatedTokens: 5,
        };
      },
    };
    assembler.register(instructions);
    const context = await assembler.assemble({ query: 'parser', tokenBudget: 60 });
    expect(context.sections.map(({ id }) => id)).toEqual(['instructions', 'repository-map']);
    expect(context.text).toContain('Always run tests.');
    expect(context.estimatedTokens).toBeLessThanOrEqual(60);

    const tiny = await assembler.assemble({ query: 'parser', tokenBudget: 8 });
    expect(tiny.estimatedTokens).toBeLessThanOrEqual(8);
    expect(tiny.truncated).toBe(true);
  });

  it('exposes repository operations through the same guarded tool pipeline', async () => {
    const { repository } = await fixture();
    const registry = new ToolRegistry();
    for (const tool of createRepositoryTools(repository)) registry.register(tool);
    const result = await new ToolPipeline(registry, {
      evaluate: () => ({ decision: 'allow' }),
    }).execute(
      {
        callId: 'read-1',
        name: 'repository.read_file',
        arguments: { rootId: 'demo', path: 'README.md', startLine: 1, endLine: 1 },
      },
      { workspaceRoot: '/workspace', mode: 'ask' },
    );
    expect(result).toMatchObject({
      ok: true,
      origin: 'official-plugin',
      text: '# Demo',
      data: { rootId: 'demo', path: 'README.md', startLine: 1, endLine: 1 },
    });
  });
});
