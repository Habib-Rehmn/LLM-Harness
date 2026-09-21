import { spawn } from 'node:child_process';
import { access, lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  FORGE_API_VERSION,
  type ForgePlugin,
  pluginName,
  serviceToken,
} from '@forge/kernel-contracts';
import type { ProcessLaunchPlan, ProcessSandbox, ProcessSpec } from '@forge/process-core';

export interface SandboxAvailability {
  readonly available: boolean;
  readonly backend: 'bubblewrap';
  readonly reason?: string;
}

export interface SandboxLimits {
  readonly addressSpaceBytes: number;
  readonly cpuSeconds: number;
  readonly processes: number;
  readonly openFiles: number;
}

export interface LinuxSandboxOptions {
  readonly workspaceRoot: string;
  readonly bubblewrapPath?: string;
  readonly prlimitPath?: string;
  readonly allowNetwork?: boolean;
  readonly required?: boolean;
  readonly limits?: Partial<SandboxLimits>;
  readonly probe?: (file: string, arguments_: readonly string[]) => Promise<boolean>;
}

export interface ExternalSandboxDeclaration {
  readonly kind: 'external';
  readonly provider: 'container' | 'remote';
  readonly isolation: 'declared-by-host';
  readonly workspaceMount: 'read-only' | 'read-write';
  readonly network: 'none' | 'allowlisted' | 'host-managed';
  readonly notes: string;
}

const DEFAULT_LIMITS: SandboxLimits = {
  addressSpaceBytes: 2 * 1024 * 1024 * 1024,
  cpuSeconds: 300,
  processes: 128,
  openFiles: 1_024,
};

export class LinuxBubblewrapSandbox implements ProcessSandbox {
  readonly id = 'linux-bubblewrap';
  readonly #rootInput: string;
  readonly #bwrap: string;
  readonly #prlimit: string;
  readonly #allowNetwork: boolean;
  readonly #required: boolean;
  readonly #limits: SandboxLimits;
  readonly #probe: (file: string, arguments_: readonly string[]) => Promise<boolean>;
  #root: string | undefined;
  #availability: Promise<SandboxAvailability> | undefined;

  constructor(options: LinuxSandboxOptions) {
    this.#rootInput = options.workspaceRoot;
    this.#bwrap = options.bubblewrapPath ?? '/usr/bin/bwrap';
    this.#prlimit = options.prlimitPath ?? '/usr/bin/prlimit';
    this.#allowNetwork = options.allowNetwork ?? false;
    this.#required = options.required ?? true;
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.#probe = options.probe ?? runProbe;
  }

  get workspaceRoot(): string {
    return resolve(this.#rootInput);
  }

  async availability(): Promise<SandboxAvailability> {
    this.#availability ??= this.#detect();
    return this.#availability;
  }

  async prepare(plan: ProcessLaunchPlan, _spec: ProcessSpec): Promise<ProcessLaunchPlan> {
    const availability = await this.availability();
    if (!availability.available) {
      if (this.#required) throw new Error(`Required sandbox unavailable: ${availability.reason}`);
      return plan;
    }
    const root = await this.#workspaceRoot();
    assertInside(root, plan.cwd);
    const arguments_: string[] = [
      '--die-with-parent',
      '--new-session',
      '--unshare-all',
      ...(this.#allowNetwork ? ['--share-net'] : []),
      '--ro-bind',
      '/',
      '/',
      '--tmpfs',
      '/tmp',
      '--tmpfs',
      '/home',
      '--tmpfs',
      '/root',
      ...mountTargetDirectories(root),
      '--bind',
      root,
      root,
    ];
    for (const protectedPath of ['.git', '.forge']) {
      const absolute = resolve(root, protectedPath);
      if (await exists(absolute)) arguments_.push('--ro-bind', absolute, absolute);
    }
    arguments_.push(
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--chdir',
      plan.cwd,
      '--',
      this.#prlimit,
      `--as=${this.#limits.addressSpaceBytes}`,
      `--cpu=${this.#limits.cpuSeconds}`,
      `--nproc=${this.#limits.processes}`,
      `--nofile=${this.#limits.openFiles}`,
      '--',
      plan.file,
      ...plan.arguments,
    );
    return { ...plan, file: this.#bwrap, arguments: arguments_ };
  }

  async #detect(): Promise<SandboxAvailability> {
    if (process.platform !== 'linux') {
      return { available: false, backend: 'bubblewrap', reason: 'Linux is required' };
    }
    if (!(await executable(this.#bwrap)) || !(await executable(this.#prlimit))) {
      return {
        available: false,
        backend: 'bubblewrap',
        reason: 'bubblewrap and prlimit executables are required',
      };
    }
    const works = await this.#probe(this.#bwrap, [
      '--ro-bind',
      '/',
      '/',
      '--unshare-user',
      '--unshare-pid',
      '--',
      '/bin/true',
    ]);
    return works
      ? { available: true, backend: 'bubblewrap' }
      : {
          available: false,
          backend: 'bubblewrap',
          reason: 'bubblewrap user namespaces are unavailable',
        };
  }

  async #workspaceRoot(): Promise<string> {
    this.#root ??= await realpath(resolve(this.#rootInput));
    return this.#root;
  }
}

function mountTargetDirectories(root: string): readonly string[] {
  const directories: string[] = [];
  let current = dirname(root);
  const chain: string[] = [];
  while (current !== '/' && current !== '.') {
    chain.push(current);
    current = dirname(current);
  }
  for (const directory of chain.reverse()) {
    if (directory === '/home') continue;
    directories.push('--dir', directory);
  }
  return directories;
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path);
    const metadata = await lstat(path);
    return metadata.isFile() && (metadata.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function runProbe(file: string, arguments_: readonly string[]): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const child = spawn(file, [...arguments_], { stdio: 'ignore', timeout: 5_000 });
    child.once('error', () => resolveProbe(false));
    child.once('close', (code) => resolveProbe(code === 0));
  });
}

function assertInside(root: string, candidate: string): void {
  if (!isAbsolute(candidate)) throw new Error('Sandbox working directory must be absolute');
  const relation = relative(root, candidate);
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error('Sandbox working directory escapes the workspace');
  }
}

export const LINUX_SANDBOX_SERVICE = serviceToken<LinuxBubblewrapSandbox>('forge.linux-sandbox');

export function createLinuxSandboxPlugin(sandbox: LinuxBubblewrapSandbox): ForgePlugin {
  return {
    manifest: {
      apiVersion: FORGE_API_VERSION,
      name: pluginName('forge-sandbox-linux'),
      version: '0.1.0',
      runtime: 'trusted',
      entrypoint: './lib/index.js',
      provides: [LINUX_SANDBOX_SERVICE.id],
      permissions: {
        filesystem: { read: ['/'], write: [sandbox.workspaceRoot] },
        subprocess: true,
      },
    },
    setup(context) {
      context.provide(LINUX_SANDBOX_SERVICE, sandbox);
    },
  };
}

export function declareExternalSandbox(
  declaration: Omit<ExternalSandboxDeclaration, 'kind' | 'isolation'>,
): ExternalSandboxDeclaration {
  return Object.freeze({ kind: 'external', isolation: 'declared-by-host', ...declaration });
}
