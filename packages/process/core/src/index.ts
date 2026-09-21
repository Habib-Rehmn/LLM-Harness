import { randomUUID } from 'node:crypto';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  FORGE_API_VERSION,
  type ForgePlugin,
  pluginName,
  serviceToken,
} from '@forge/kernel-contracts';
import { TOOL_REGISTRY_SERVICE, type Tool } from '@forge/tools-core';

export interface ProcessSpec {
  readonly argv?: readonly [string, ...string[]];
  readonly shell?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly pty?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxOutputLines?: number;
}

export type ProcessState = 'running' | 'exited' | 'timed_out' | 'cancelled' | 'failed';

export interface ProcessChunk {
  readonly id: string;
  readonly stream: 'stdout' | 'stderr';
  readonly data: string;
}

export interface ProcessResult {
  readonly id: string;
  readonly state: Exclude<ProcessState, 'running'>;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly originalBytes: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly error?: string;
}

export interface ProcessManagerOptions {
  readonly inheritedEnvironment?: readonly string[];
  readonly allowedEnvironment?: readonly string[];
  readonly redactedValues?: readonly string[];
  readonly defaultTimeoutMs?: number;
  readonly defaultMaxOutputBytes?: number;
  readonly defaultMaxOutputLines?: number;
  readonly killGraceMs?: number;
  readonly sandbox?: ProcessSandbox;
  readonly requireSandbox?: boolean;
}

export interface ProcessLaunchPlan {
  readonly file: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

export interface ProcessSandbox {
  readonly id: string;
  prepare(plan: ProcessLaunchPlan, spec: ProcessSpec): Promise<ProcessLaunchPlan>;
}

const SAFE_INHERITED_ENV = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM'];

export class ManagedProcess {
  readonly id: string;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #stdout: BoundedOutput;
  readonly #stderr: BoundedOutput;
  readonly #listeners = new Set<(chunk: ProcessChunk) => void>();
  readonly #startedAt = new Date();
  readonly #completion: Promise<ProcessResult>;
  readonly #killGraceMs: number;
  #state: ProcessState = 'running';
  #timer: ReturnType<typeof setTimeout> | undefined;
  #error: string | undefined;

  constructor(
    child: ChildProcessWithoutNullStreams,
    options: {
      readonly id: string;
      readonly timeoutMs: number;
      readonly maxOutputBytes: number;
      readonly maxOutputLines: number;
      readonly redactedValues: readonly string[];
      readonly signal?: AbortSignal;
      readonly killGraceMs: number;
    },
  ) {
    this.id = options.id;
    this.#child = child;
    this.#killGraceMs = options.killGraceMs;
    this.#stdout = new BoundedOutput(
      options.maxOutputBytes,
      options.maxOutputLines,
      options.redactedValues,
    );
    this.#stderr = new BoundedOutput(
      options.maxOutputBytes,
      options.maxOutputLines,
      options.redactedValues,
    );
    const abort = () => void this.#terminate('cancelled');
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.timeoutMs > 0) {
      this.#timer = setTimeout(() => void this.#terminate('timed_out'), options.timeoutMs);
    }
    child.stdout.on('data', (chunk: Buffer) => this.#capture('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => this.#capture('stderr', chunk));
    this.#completion = new Promise((resolveCompletion) => {
      child.once('error', (error) => {
        this.#state = 'failed';
        this.#error = error.message;
      });
      child.once('close', (code, signal) => {
        clearTimeout(this.#timer);
        options.signal?.removeEventListener('abort', abort);
        const finishedAt = new Date();
        const state = this.#state === 'running' ? 'exited' : this.#state;
        this.#state = state;
        resolveCompletion({
          id: this.id,
          state,
          exitCode: code,
          signal,
          stdout: this.#stdout.text(),
          stderr: this.#stderr.text(),
          truncated: this.#stdout.truncated || this.#stderr.truncated,
          originalBytes: this.#stdout.originalBytes + this.#stderr.originalBytes,
          startedAt: this.#startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - this.#startedAt.getTime(),
          ...(this.#error ? { error: this.#error } : {}),
        });
      });
    });
    if (options.signal?.aborted) void this.#terminate('cancelled');
  }

  get state(): ProcessState {
    return this.#state;
  }

  onOutput(listener: (chunk: ProcessChunk) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  write(data: string): void {
    if (this.#state !== 'running' || !this.#child.stdin.writable) {
      throw new Error(`Process ${this.id} is not accepting input`);
    }
    this.#child.stdin.write(data);
  }

  closeInput(): void {
    if (this.#child.stdin.writable) this.#child.stdin.end();
  }

  async kill(): Promise<void> {
    await this.#terminate('cancelled');
  }

  wait(): Promise<ProcessResult> {
    return this.#completion;
  }

  #capture(stream: ProcessChunk['stream'], chunk: Buffer): void {
    const output = stream === 'stdout' ? this.#stdout : this.#stderr;
    const data = output.append(chunk.toString('utf8'));
    const event = { id: this.id, stream, data } as const;
    for (const listener of this.#listeners) listener(event);
  }

  async #terminate(state: 'timed_out' | 'cancelled'): Promise<void> {
    if (this.#state !== 'running') return;
    this.#state = state;
    killTree(this.#child.pid, 'SIGTERM');
    const timer = setTimeout(() => {
      if (this.#child.exitCode === null) killTree(this.#child.pid, 'SIGKILL');
    }, this.#killGraceMs);
    timer.unref();
  }
}

export class ProcessManager {
  readonly #root: string;
  readonly #options: Omit<Required<ProcessManagerOptions>, 'sandbox'> & {
    readonly sandbox?: ProcessSandbox;
  };
  readonly #processes = new Map<string, ManagedProcess>();

  private constructor(root: string, options: ProcessManagerOptions) {
    this.#root = root;
    this.#options = {
      inheritedEnvironment: options.inheritedEnvironment ?? SAFE_INHERITED_ENV,
      allowedEnvironment: options.allowedEnvironment ?? [],
      redactedValues: options.redactedValues ?? [],
      defaultTimeoutMs: options.defaultTimeoutMs ?? 120_000,
      defaultMaxOutputBytes: options.defaultMaxOutputBytes ?? 128_000,
      defaultMaxOutputLines: options.defaultMaxOutputLines ?? 2_000,
      killGraceMs: options.killGraceMs ?? 250,
      ...(options.sandbox ? { sandbox: options.sandbox } : {}),
      requireSandbox: options.requireSandbox ?? false,
    };
  }

  static async create(root: string, options: ProcessManagerOptions = {}): Promise<ProcessManager> {
    return new ProcessManager(await realpath(resolve(root)), options);
  }

  get root(): string {
    return this.#root;
  }

  async start(spec: ProcessSpec, signal?: AbortSignal): Promise<ManagedProcess> {
    validateSpec(spec);
    const cwd = await this.#workingDirectory(spec.cwd);
    const environment = this.#environment(spec.env);
    const command = commandFor(spec);
    if (this.#options.requireSandbox && !this.#options.sandbox) {
      throw new Error('A process sandbox is required but none is configured');
    }
    const initial: ProcessLaunchPlan = {
      file: command.file,
      arguments: command.arguments,
      cwd,
      env: environment,
    };
    const launch = this.#options.sandbox
      ? await this.#options.sandbox.prepare(initial, spec)
      : initial;
    const child = spawn(launch.file, [...launch.arguments], {
      cwd: launch.cwd,
      env: launch.env,
      detached: process.platform !== 'win32',
      stdio: 'pipe',
      windowsHide: true,
    });
    const handle = new ManagedProcess(child, {
      id: randomUUID(),
      timeoutMs: spec.timeoutMs ?? this.#options.defaultTimeoutMs,
      maxOutputBytes: spec.maxOutputBytes ?? this.#options.defaultMaxOutputBytes,
      maxOutputLines: spec.maxOutputLines ?? this.#options.defaultMaxOutputLines,
      redactedValues: [
        ...this.#options.redactedValues,
        ...Object.entries(spec.env ?? {})
          .filter(([key]) => isSecretKey(key))
          .map(([, value]) => value),
      ],
      ...(signal ? { signal } : {}),
      killGraceMs: this.#options.killGraceMs,
    });
    this.#processes.set(handle.id, handle);
    return handle;
  }

  async run(spec: ProcessSpec, signal?: AbortSignal): Promise<ProcessResult> {
    const handle = await this.start(spec, signal);
    return handle.wait();
  }

  get(id: string): ManagedProcess {
    const process = this.#processes.get(id);
    if (!process) throw new Error(`Process handle ${id} was not found`);
    return process;
  }

  async wait(id: string): Promise<ProcessResult> {
    return this.get(id).wait();
  }

  async kill(id: string): Promise<void> {
    await this.get(id).kill();
  }

  write(id: string, data: string, close = false): void {
    const process = this.get(id);
    if (data) process.write(data);
    if (close) process.closeInput();
  }

  async #workingDirectory(input = '.'): Promise<string> {
    if (isAbsolute(input) || input.includes('\0'))
      throw new Error('Working directory must be relative');
    const candidate = resolve(this.#root, input);
    assertInside(this.#root, candidate);
    const parts = relative(this.#root, candidate).split(sep).filter(Boolean);
    let current = this.#root;
    for (const part of parts) {
      current = resolve(current, part);
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) throw new Error('Symlink working directories are forbidden');
      if (!metadata.isDirectory()) throw new Error('Working directory is not a directory');
    }
    const canonical = await realpath(candidate);
    assertInside(this.#root, canonical);
    return canonical;
  }

  #environment(additions: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const key of this.#options.inheritedEnvironment) {
      const value = process.env[key];
      if (value !== undefined) environment[key] = value;
    }
    const allowed = new Set(this.#options.allowedEnvironment);
    for (const [key, value] of Object.entries(additions)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment key: ${key}`);
      if (!allowed.has(key)) throw new Error(`Environment key is not allowed: ${key}`);
      environment[key] = value;
    }
    return environment;
  }
}

class BoundedOutput {
  readonly #maxBytes: number;
  readonly #maxLines: number;
  readonly #redactedValues: readonly string[];
  #head = '';
  #tail = '';
  originalBytes = 0;
  truncated = false;

  constructor(maxBytes: number, maxLines: number, redactedValues: readonly string[]) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new Error('Output limit must be positive');
    if (!Number.isSafeInteger(maxLines) || maxLines <= 0)
      throw new Error('Line limit must be positive');
    this.#maxBytes = maxBytes;
    this.#maxLines = maxLines;
    this.#redactedValues = redactedValues.filter(Boolean).sort((a, b) => b.length - a.length);
  }

  append(value: string): string {
    const redacted = this.#redactedValues.reduce(
      (text, secret) => text.replaceAll(secret, '[REDACTED]'),
      value,
    );
    this.originalBytes += Buffer.byteLength(redacted);
    const half = Math.max(1, Math.floor(this.#maxBytes / 2));
    if (!this.truncated) {
      const combined = `${this.#head}${redacted}`;
      if (this.originalBytes <= this.#maxBytes) {
        this.#head = combined;
        return redacted;
      }
      this.#head = takeUtf8(combined, half, false);
      this.#tail = takeUtf8(combined, half, true);
      this.truncated = true;
    } else {
      this.#tail = takeUtf8(`${this.#tail}${redacted}`, half, true);
    }
    return redacted;
  }

  text(): string {
    const combined = this.truncated
      ? `${this.#head}\n… output truncated …\n${this.#tail}`
      : this.#head;
    const lines = combined.split('\n');
    if (lines.length <= this.#maxLines) return combined;
    this.truncated = true;
    const first = Math.ceil(this.#maxLines / 2);
    const last = Math.floor(this.#maxLines / 2);
    return `${lines.slice(0, first).join('\n')}\n… output truncated …\n${lines.slice(-last).join('\n')}`;
  }
}

function validateSpec(spec: ProcessSpec): void {
  if ((spec.argv === undefined) === (spec.shell === undefined)) {
    throw new Error('Specify exactly one of argv or shell');
  }
  if (spec.argv?.some((argument) => argument.includes('\0')) || spec.shell?.includes('\0')) {
    throw new Error('Process command contains a NUL byte');
  }
}

function commandFor(spec: ProcessSpec): { file: string; arguments: string[] } {
  if (spec.pty) {
    const command = spec.shell ?? (spec.argv ?? []).map(shellQuote).join(' ');
    return { file: 'script', arguments: ['-qefc', `exec ${command}`, '/dev/null'] };
  }
  if (spec.argv) return { file: spec.argv[0], arguments: [...spec.argv.slice(1)] };
  return { file: '/bin/sh', arguments: ['-lc', spec.shell ?? ''] };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function assertInside(root: string, candidate: string): void {
  const relation = relative(root, candidate);
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error('Working directory escapes the workspace');
  }
}

function isSecretKey(key: string): boolean {
  return /(?:secret|token|password|credential|api[_-]?key)/i.test(key);
}

function takeUtf8(value: string, bytes: number, end: boolean): string {
  const characters = Array.from(value);
  const selected: string[] = [];
  let used = 0;
  const iterable = end ? characters.reverse() : characters;
  for (const character of iterable) {
    const size = Buffer.byteLength(character);
    if (used + size > bytes) break;
    selected.push(character);
    used += size;
  }
  if (end) selected.reverse();
  return selected.join('');
}

export const PROCESS_MANAGER_SERVICE = serviceToken<ProcessManager>('forge.process-manager');

export function createProcessTools(manager: ProcessManager): readonly Tool[] {
  return [
    runTool(manager),
    startTool(manager),
    inputTool(manager),
    waitTool(manager),
    killTool(manager),
    ...gitTools(manager),
  ];
}

function processSchema(background: boolean) {
  return {
    type: 'object',
    properties: {
      argv: { type: 'array', minItems: 1, items: { type: 'string' } },
      shell: { type: 'string', minLength: 1 },
      cwd: { type: 'string' },
      pty: { type: 'boolean' },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 600_000 },
      ...(background ? {} : { maxOutputBytes: { type: 'integer', minimum: 128 } }),
    },
    oneOf: [{ required: ['argv'] }, { required: ['shell'] }],
    additionalProperties: false,
  };
}

function baseDefinition(name: string, description: string, readOnly: boolean): Tool['definition'] {
  return {
    name,
    version: '1.0.0',
    description,
    inputSchema: {},
    capabilities: [readOnly ? 'subprocess.read' : 'subprocess.execute'],
    risk: readOnly ? 'safe' : 'sensitive',
    readOnly,
    idempotent: readOnly,
    timeoutMs: 610_000,
    maxOutputBytes: 128_000,
    maxOutputLines: 2_000,
    origin: 'official-plugin',
  };
}

function runTool(manager: ProcessManager): Tool {
  return {
    definition: {
      ...baseDefinition(
        'shell.run',
        'Run a foreground command inside the workspace. Prefer argv; use shell only for intentional shell syntax.',
        false,
      ),
      inputSchema: processSchema(false),
    },
    async execute(arguments_, context) {
      const result = await manager.run(arguments_ as unknown as ProcessSpec, context.signal);
      return processOutput(result);
    },
  };
}

function startTool(manager: ProcessManager): Tool {
  return {
    definition: {
      ...baseDefinition(
        'shell.start',
        'Start a background or interactive workspace command and return a handle for process.write, process.wait, or process.kill.',
        false,
      ),
      inputSchema: processSchema(true),
    },
    async execute(arguments_, context) {
      const handle = await manager.start(arguments_ as unknown as ProcessSpec, context.signal);
      return { text: `Started process ${handle.id}`, data: { id: handle.id, state: handle.state } };
    },
  };
}

function inputTool(manager: ProcessManager): Tool {
  return {
    definition: {
      ...baseDefinition(
        'process.write',
        'Write exact text to a running process and optionally close stdin.',
        false,
      ),
      inputSchema: {
        type: 'object',
        required: ['id', 'data'],
        properties: {
          id: { type: 'string' },
          data: { type: 'string' },
          close: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
    async execute(arguments_) {
      manager.write(String(arguments_.id), String(arguments_.data), arguments_.close === true);
      return { text: 'Input delivered' };
    },
  };
}

function waitTool(manager: ProcessManager): Tool {
  return {
    definition: {
      ...baseDefinition(
        'process.wait',
        'Wait for a background process and return its bounded output.',
        true,
      ),
      inputSchema: handleSchema(),
    },
    async execute(arguments_) {
      return processOutput(await manager.wait(String(arguments_.id)));
    },
  };
}

function killTool(manager: ProcessManager): Tool {
  return {
    definition: {
      ...baseDefinition(
        'process.kill',
        'Terminate a background process and its descendant process group.',
        false,
      ),
      inputSchema: handleSchema(),
    },
    async execute(arguments_) {
      await manager.kill(String(arguments_.id));
      return { text: 'Termination requested' };
    },
  };
}

function handleSchema() {
  return {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', minLength: 1 } },
    additionalProperties: false,
  };
}

function gitTools(manager: ProcessManager): readonly Tool[] {
  const definitions = [
    ['git.status', 'Show concise repository status.', ['status', '--short', '--branch']],
    [
      'git.diff',
      'Show unstaged repository changes without modifying files.',
      ['diff', '--no-ext-diff'],
    ],
    ['git.log', 'Show recent commit summaries.', ['log', '--oneline', '--decorate', '-20']],
  ] as const;
  return definitions.map(([name, description, arguments_]) => ({
    definition: {
      ...baseDefinition(name, description, true),
      inputSchema: {
        type: 'object',
        properties: { cwd: { type: 'string' } },
        additionalProperties: false,
      },
    },
    async execute(input, context) {
      return processOutput(
        await manager.run(
          {
            argv: ['git', ...arguments_],
            ...(typeof input.cwd === 'string' ? { cwd: input.cwd } : {}),
          },
          context.signal,
        ),
      );
    },
  }));
}

function processOutput(result: ProcessResult) {
  const text = [result.stdout, result.stderr].filter(Boolean).join('\n');
  return {
    text,
    data: {
      id: result.id,
      state: result.state,
      exitCode: result.exitCode,
      signal: result.signal,
      truncated: result.truncated,
      originalBytes: result.originalBytes,
      durationMs: result.durationMs,
    },
  };
}

export function createProcessPlugin(manager: ProcessManager): ForgePlugin {
  return {
    manifest: {
      apiVersion: FORGE_API_VERSION,
      name: pluginName('forge-process-core'),
      version: '0.1.0',
      runtime: 'trusted',
      entrypoint: './lib/index.js',
      optional: { [TOOL_REGISTRY_SERVICE.id]: '^0.1.0' },
      provides: [PROCESS_MANAGER_SERVICE.id],
      permissions: {
        filesystem: { read: [manager.root], write: [manager.root] },
        subprocess: true,
      },
    },
    setup(context) {
      context.provide(PROCESS_MANAGER_SERVICE, manager);
      const tools = context.optional(TOOL_REGISTRY_SERVICE);
      if (tools)
        for (const tool of createProcessTools(manager)) context.effect(tools.register(tool));
    },
  };
}
