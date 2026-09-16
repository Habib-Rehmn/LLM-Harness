import { access, mkdtemp, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProcessManager } from './index.js';

async function fixture(options: Parameters<typeof ProcessManager.create>[1] = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'forge-process-'));
  return { directory, manager: await ProcessManager.create(directory, options) };
}

describe('process manager', () => {
  it('runs argv and explicit shell commands with validated working directories', async () => {
    const { directory, manager } = await fixture();
    await mkdir(join(directory, 'nested'));
    const argv = await manager.run({
      argv: [process.execPath, '-e', 'process.stdout.write(process.cwd())'],
      cwd: 'nested',
    });
    expect(argv.state).toBe('exited');
    expect(argv.exitCode).toBe(0);
    expect(argv.stdout).toBe(join(directory, 'nested'));
    const shell = await manager.run({ shell: 'printf shell-ok' });
    expect(shell.stdout).toBe('shell-ok');
    await expect(manager.run({ argv: ['pwd'], cwd: '../' })).rejects.toThrow('escapes');
    await symlink(join(directory, 'nested'), join(directory, 'linked'));
    await expect(manager.run({ argv: ['pwd'], cwd: 'linked' })).rejects.toThrow('Symlink');
  });

  it('supports interactive background input and a real pseudo-terminal', async () => {
    const { manager } = await fixture();
    const handle = await manager.start({
      argv: [
        process.execPath,
        '-e',
        "process.stdin.setEncoding('utf8');process.stdin.once('data',d=>process.stdout.write('got:'+d.trim()))",
      ],
    });
    handle.write('hello\n');
    handle.closeInput();
    expect(await handle.wait()).toMatchObject({ state: 'exited', stdout: 'got:hello' });

    const pty = await manager.run({
      argv: [process.execPath, '-e', 'process.stdout.write(String(process.stdout.isTTY))'],
      pty: true,
    });
    expect(pty.stdout).toContain('true');
  });

  it('bounds noisy output and redacts configured and secret environment values', async () => {
    const secret = 'super-secret-value';
    const { manager } = await fixture({
      allowedEnvironment: ['API_TOKEN'],
      redactedValues: ['fixed-secret'],
    });
    const result = await manager.run({
      argv: [
        process.execPath,
        '-e',
        "process.stdout.write('head fixed-secret '+process.env.API_TOKEN+' '+('x'.repeat(5000))+' tail')",
      ],
      env: { API_TOKEN: secret },
      maxOutputBytes: 200,
      maxOutputLines: 10,
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout).toContain('head [REDACTED] [REDACTED]');
    expect(result.stdout).toContain('tail');
    expect(result.stdout).not.toContain(secret);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(240);
    await expect(manager.run({ argv: ['true'], env: { UNAPPROVED: 'x' } })).rejects.toThrow(
      'not allowed',
    );

    const withinLimit = await manager.run({
      argv: [process.execPath, '-e', "process.stdout.write('y'.repeat(150))"],
      maxOutputBytes: 200,
    });
    expect(withinLimit.stdout).toBe('y'.repeat(150));
    expect(withinLimit.truncated).toBe(false);
  });

  it('times out and terminates the complete descendant process group', async () => {
    const { directory, manager } = await fixture({ killGraceMs: 20 });
    const marker = join(directory, 'child-survived');
    const source = [
      "const {spawn}=require('node:child_process')",
      `spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad'),180)`)}],{stdio:'ignore'})`,
      'setInterval(()=>{},1000)',
    ].join(';');
    const result = await manager.run({
      argv: [process.execPath, '-e', source],
      timeoutMs: 40,
    });
    expect(result.state).toBe('timed_out');
    await new Promise((resolve) => setTimeout(resolve, 240));
    await expect(access(marker)).rejects.toThrow();
  });
});
