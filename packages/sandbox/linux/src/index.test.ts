import { access, mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ProcessLaunchPlan, ProcessManager } from '@forge/process-core';
import { describe, expect, it } from 'vitest';
import {
  declareExternalSandbox,
  LinuxBubblewrapSandbox,
  type SandboxAvailability,
} from './index.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'forge-sandbox-'));
  await mkdir(join(root, '.git'));
  await mkdir(join(root, '.forge'));
  return root;
}

function plan(root: string): ProcessLaunchPlan {
  return {
    file: '/bin/sh',
    arguments: ['-c', 'printf ok'],
    cwd: root,
    env: { PATH: process.env.PATH },
  };
}

describe('Linux bubblewrap sandbox', () => {
  it('builds a network-denied, resource-limited, inherited sandbox launch', async () => {
    const root = await fixture();
    const sandbox = new LinuxBubblewrapSandbox({
      workspaceRoot: root,
      bubblewrapPath: '/bin/true',
      prlimitPath: '/bin/true',
      probe: async () => true,
      limits: { cpuSeconds: 12, processes: 16 },
    });
    expect(await sandbox.availability()).toEqual({ available: true, backend: 'bubblewrap' });
    const prepared = await sandbox.prepare(plan(root), { argv: ['/bin/sh', '-c', 'printf ok'] });
    expect(prepared.file).toBe('/bin/true');
    expect(prepared.arguments).toEqual(
      expect.arrayContaining([
        '--die-with-parent',
        '--unshare-all',
        '--tmpfs',
        '/tmp',
        '--bind',
        root,
        root,
        '--ro-bind',
        join(root, '.git'),
        join(root, '.git'),
        '--cpu=12',
        '--nproc=16',
        '/bin/sh',
        '-c',
        'printf ok',
      ]),
    );
    expect(prepared.arguments).not.toContain('--share-net');
    const commandIndex = prepared.arguments.lastIndexOf('/bin/sh');
    expect(prepared.arguments.slice(commandIndex)).toEqual(['/bin/sh', '-c', 'printf ok']);
  });

  it('fails closed when required support is missing or no sandbox is configured', async () => {
    const root = await fixture();
    const unavailable = new LinuxBubblewrapSandbox({
      workspaceRoot: root,
      probe: async () => false,
    });
    await expect(unavailable.prepare(plan(root), { argv: ['/bin/true'] })).rejects.toThrow(
      'Required sandbox unavailable',
    );
    const manager = await ProcessManager.create(root, { requireSandbox: true });
    await expect(manager.run({ argv: ['/bin/true'] })).rejects.toThrow('sandbox is required');
  });

  it('rejects a working directory outside the workspace before launch', async () => {
    const root = await fixture();
    const sandbox = new LinuxBubblewrapSandbox({
      workspaceRoot: root,
      bubblewrapPath: '/bin/true',
      prlimitPath: '/bin/true',
      probe: async () => true,
    });
    await expect(
      sandbox.prepare({ ...plan(root), cwd: tmpdir() }, { argv: ['/bin/true'] }),
    ).rejects.toThrow('escapes');
  });

  it('denies host escapes when bubblewrap is available, otherwise reports fail-closed state', async () => {
    const root = await fixture();
    const sandbox = new LinuxBubblewrapSandbox({ workspaceRoot: root });
    const availability: SandboxAvailability = await sandbox.availability();
    if (!availability.available) {
      await expect(sandbox.prepare(plan(root), { argv: ['/bin/true'] })).rejects.toThrow(
        'Required sandbox unavailable',
      );
      return;
    }
    const marker = join(root, '..', `escape-${Date.now()}`);
    const manager = await ProcessManager.create(root, { sandbox, requireSandbox: true });
    const server = createServer((_request, response) => response.end('reachable'));
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Fixture server address is invalid');
    const source = [
      "const {spawnSync}=require('node:child_process')",
      `require('node:fs').writeFileSync('../${marker.split('/').at(-1)}','ephemeral')`,
      "const child=spawnSync('/bin/sh',['-c','touch .git/forbidden'])",
      `(async()=>{try{await fetch('http://127.0.0.1:${address.port}');process.exit(9)}catch{process.exit(child.status===0?8:0)}})()`,
    ].join(';');
    try {
      const result = await manager.run({ argv: ['/usr/bin/node', '-e', source] });
      expect(result.exitCode).toBe(0);
      await expect(access(marker)).rejects.toThrow();
      await expect(access(join(root, '.git/forbidden'))).rejects.toThrow();
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
    }
  });

  it('declares external/container isolation without pretending to enforce it locally', () => {
    expect(
      declareExternalSandbox({
        provider: 'container',
        workspaceMount: 'read-write',
        network: 'allowlisted',
        notes: 'CI container owns namespace and seccomp configuration.',
      }),
    ).toEqual({
      kind: 'external',
      isolation: 'declared-by-host',
      provider: 'container',
      workspaceMount: 'read-write',
      network: 'allowlisted',
      notes: 'CI container owns namespace and seccomp configuration.',
    });
  });
});
