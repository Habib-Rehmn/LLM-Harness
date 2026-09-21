import {
  FORGE_API_VERSION,
  type ForgePlugin,
  pluginName,
  serviceToken,
} from '@forge/kernel-contracts';

export type InterfaceEvent =
  | { readonly type: 'message'; readonly role: 'user' | 'assistant'; readonly text: string }
  | { readonly type: 'plan'; readonly text: string; readonly status: string }
  | { readonly type: 'tool'; readonly name: string; readonly status: string }
  | { readonly type: 'output'; readonly stream: 'stdout' | 'stderr'; readonly text: string }
  | { readonly type: 'diff'; readonly text: string }
  | {
      readonly type: 'budget';
      readonly iterations: number;
      readonly tokens: number;
      readonly toolCalls: number;
    }
  | {
      readonly type: 'approval';
      readonly approvalId: string;
      readonly reason: string;
      readonly ruleId: string;
    }
  | { readonly type: 'status'; readonly text: string }
  | { readonly type: 'error'; readonly message: string; readonly code?: string };

export type InterfaceCommand =
  | 'mode'
  | 'status'
  | 'context'
  | 'diff'
  | 'permissions'
  | 'compact'
  | 'fork';

export interface InterfaceCommandResult {
  readonly text: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface InterfaceSession {
  submit(prompt: string, signal?: AbortSignal): AsyncIterable<InterfaceEvent>;
  command(name: InterfaceCommand, arguments_: readonly string[]): Promise<InterfaceCommandResult>;
  cancel(reason?: string): void;
}

export interface TerminalIo {
  write(text: string): void;
  approve?(event: Extract<InterfaceEvent, { type: 'approval' }>): Promise<boolean>;
}

export interface TerminalResult {
  readonly reason: 'exit' | 'input-ended';
  readonly prompts: number;
  readonly commands: number;
}

const COMMANDS = new Set<InterfaceCommand>([
  'mode',
  'status',
  'context',
  'diff',
  'permissions',
  'compact',
  'fork',
]);

export class TerminalInterface {
  readonly #session: InterfaceSession;
  readonly #io: TerminalIo;

  constructor(session: InterfaceSession, io: TerminalIo) {
    this.#session = session;
    this.#io = io;
  }

  async run(lines: AsyncIterable<string>, signal?: AbortSignal): Promise<TerminalResult> {
    let prompts = 0;
    let commands = 0;
    for await (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('/')) {
        const [name = '', ...arguments_] = line.slice(1).split(/\s+/);
        if (name === 'exit') return { reason: 'exit', prompts, commands };
        if (name === 'cancel') {
          this.#session.cancel(arguments_.join(' ') || 'Cancelled from terminal');
          this.#io.write('[cancel] requested');
          commands += 1;
          continue;
        }
        if (!COMMANDS.has(name as InterfaceCommand)) {
          this.#io.write(`[error] Unknown command: /${name}`);
          continue;
        }
        const result = await this.#session.command(name as InterfaceCommand, arguments_);
        this.#io.write(`[${name}] ${result.text}`);
        commands += 1;
        continue;
      }
      prompts += 1;
      for await (const event of this.#session.submit(line, signal)) {
        this.#io.write(renderTerminalEvent(event));
        if (event.type === 'approval' && this.#io.approve) {
          const approved = await this.#io.approve(event);
          const result = await this.#session.command('permissions', [
            approved ? 'allow' : 'deny',
            event.approvalId,
          ]);
          this.#io.write(`[permissions] ${result.text}`);
        }
      }
    }
    return { reason: 'input-ended', prompts, commands };
  }
}

export type HeadlessFormat = 'text' | 'json' | 'jsonl';
export type NonInteractiveApproval = 'deny' | 'error';

export const FORGE_EXIT_CODES = Object.freeze({
  success: 0,
  failure: 1,
  usage: 2,
  approvalRequired: 3,
  unavailable: 4,
  cancelled: 130,
});

export interface HeadlessOptions {
  readonly format?: HeadlessFormat;
  readonly approval?: NonInteractiveApproval;
  readonly signal?: AbortSignal;
}

export interface HeadlessOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}

export class HeadlessExecutor {
  readonly #session: InterfaceSession;

  constructor(session: InterfaceSession) {
    this.#session = session;
  }

  async execute(
    prompt: string,
    output: HeadlessOutput,
    options: HeadlessOptions = {},
  ): Promise<number> {
    if (!prompt.trim()) {
      output.stderr('A non-empty prompt is required');
      return FORGE_EXIT_CODES.usage;
    }
    const format = options.format ?? 'text';
    const events: InterfaceEvent[] = [];
    try {
      for await (const event of this.#session.submit(prompt, options.signal)) {
        events.push(event);
        if (format === 'jsonl') output.stdout(JSON.stringify(event));
        if (format === 'text') {
          const rendered = renderHeadlessText(event);
          if (rendered) (event.type === 'error' ? output.stderr : output.stdout)(rendered);
        }
        if (event.type === 'approval') {
          if ((options.approval ?? 'error') === 'deny') {
            await this.#session.command('permissions', ['deny', event.approvalId]);
          }
          this.#session.cancel('Non-interactive approval required');
          if (format === 'json') {
            output.stdout(JSON.stringify({ ok: false, events, approvalRequired: true }));
          }
          return FORGE_EXIT_CODES.approvalRequired;
        }
        if (event.type === 'error') {
          if (format === 'json') output.stdout(JSON.stringify({ ok: false, events }));
          return FORGE_EXIT_CODES.failure;
        }
      }
      if (format === 'json') output.stdout(JSON.stringify({ ok: true, events }));
      return FORGE_EXIT_CODES.success;
    } catch (error) {
      if (options.signal?.aborted) return FORGE_EXIT_CODES.cancelled;
      output.stderr(error instanceof Error ? error.message : String(error));
      return FORGE_EXIT_CODES.failure;
    }
  }
}

export function renderTerminalEvent(event: InterfaceEvent): string {
  switch (event.type) {
    case 'message':
      return `[${event.role}] ${event.text}`;
    case 'plan':
      return `[plan:${event.status}] ${event.text}`;
    case 'tool':
      return `[tool:${event.status}] ${event.name}`;
    case 'output':
      return `[${event.stream}] ${event.text}`;
    case 'diff':
      return `[diff]\n${event.text}`;
    case 'budget':
      return `[budget] iterations=${event.iterations} tokens=${event.tokens} tools=${event.toolCalls}`;
    case 'approval':
      return `[approval:${event.ruleId}] ${event.reason}`;
    case 'status':
      return `[status] ${event.text}`;
    case 'error':
      return `[error${event.code ? `:${event.code}` : ''}] ${event.message}`;
  }
}

function renderHeadlessText(event: InterfaceEvent): string | undefined {
  if (event.type === 'message' && event.role === 'assistant') return event.text;
  if (event.type === 'output') return event.text;
  if (event.type === 'diff') return event.text;
  if (event.type === 'error') return event.message;
  return undefined;
}

export const INTERFACE_SESSION_SERVICE = serviceToken<InterfaceSession>('forge.interface-session');
export const TERMINAL_INTERFACE_SERVICE = serviceToken<TerminalInterface>(
  'forge.terminal-interface',
);
export const HEADLESS_EXECUTOR_SERVICE = serviceToken<HeadlessExecutor>('forge.headless-executor');

export function createInterfacePlugin(
  session: InterfaceSession,
  terminalIo: TerminalIo,
): ForgePlugin {
  return {
    manifest: {
      apiVersion: FORGE_API_VERSION,
      name: pluginName('forge-interfaces-core'),
      version: '0.1.0',
      runtime: 'trusted',
      entrypoint: './lib/index.js',
      provides: [
        INTERFACE_SESSION_SERVICE.id,
        TERMINAL_INTERFACE_SERVICE.id,
        HEADLESS_EXECUTOR_SERVICE.id,
      ],
      permissions: {},
    },
    setup(context) {
      context.provide(INTERFACE_SESSION_SERVICE, session);
      context.provide(TERMINAL_INTERFACE_SERVICE, new TerminalInterface(session, terminalIo));
      context.provide(HEADLESS_EXECUTOR_SERVICE, new HeadlessExecutor(session));
    },
  };
}
