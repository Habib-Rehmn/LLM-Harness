import { describe, expect, it } from 'vitest';
import {
  FORGE_EXIT_CODES,
  HeadlessExecutor,
  TerminalInterface,
  type InterfaceCommand,
  type InterfaceEvent,
  type InterfaceSession,
} from './index.js';

class FakeSession implements InterfaceSession {
  readonly prompts: string[] = [];
  readonly commands: string[] = [];
  readonly events: InterfaceEvent[][];
  cancelled = false;

  constructor(events: InterfaceEvent[][]) {
    this.events = events;
  }

  async *submit(prompt: string): AsyncIterable<InterfaceEvent> {
    this.prompts.push(prompt);
    for (const event of this.events.shift() ?? []) yield event;
  }

  async command(name: InterfaceCommand, arguments_: readonly string[]) {
    this.commands.push([name, ...arguments_].join(' '));
    return { text: `${name} ok` };
  }

  cancel(): void {
    this.cancelled = true;
  }
}

async function* lines(values: readonly string[]) {
  for (const value of values) yield value;
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    output: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
  };
}

describe('terminal interface', () => {
  it('streams all activity and implements the complete slash-command surface', async () => {
    const session = new FakeSession([
      [
        { type: 'message', role: 'assistant', text: 'Working' },
        { type: 'plan', text: 'Inspect', status: 'in_progress' },
        { type: 'tool', name: 'repository.read_file', status: 'running' },
        { type: 'output', stream: 'stdout', text: 'test output' },
        { type: 'diff', text: '+change' },
        { type: 'budget', iterations: 2, tokens: 40, toolCalls: 1 },
        { type: 'status', text: 'done' },
      ],
    ]);
    const rendered: string[] = [];
    const terminal = new TerminalInterface(session, { write: (text) => rendered.push(text) });
    const result = await terminal.run(
      lines([
        'fix it',
        '/mode plan',
        '/status',
        '/context',
        '/diff',
        '/permissions list',
        '/compact',
        '/fork',
        '/cancel stop',
        '/exit',
      ]),
    );
    expect(result).toEqual({ reason: 'exit', prompts: 1, commands: 8 });
    expect(session.commands).toEqual([
      'mode plan',
      'status',
      'context',
      'diff',
      'permissions list',
      'compact',
      'fork',
    ]);
    expect(session.cancelled).toBe(true);
    expect(rendered.join('\n')).toContain('[tool:running] repository.read_file');
    expect(rendered.join('\n')).toContain('[budget] iterations=2 tokens=40 tools=1');
    expect(rendered.join('\n')).toContain('[diff]\n+change');
  });

  it('handles approvals interactively through the same permissions command', async () => {
    const session = new FakeSession([
      [{ type: 'approval', approvalId: 'approval-1', reason: 'Run shell', ruleId: 'ask-shell' }],
    ]);
    const terminal = new TerminalInterface(session, {
      write: () => undefined,
      approve: async () => true,
    });
    await terminal.run(lines(['run it']));
    expect(session.commands).toEqual(['permissions allow approval-1']);
  });
});

describe('headless interface', () => {
  it('drives the same session with text, JSON, and JSONL output', async () => {
    for (const format of ['text', 'json', 'jsonl'] as const) {
      const session = new FakeSession([
        [
          { type: 'tool', name: 'repository.read_file', status: 'completed' },
          { type: 'message', role: 'assistant', text: 'Done' },
        ],
      ]);
      const output = capture();
      expect(
        await new HeadlessExecutor(session).execute('inspect', output.output, { format }),
      ).toBe(FORGE_EXIT_CODES.success);
      expect(session.prompts).toEqual(['inspect']);
      if (format === 'text') expect(output.stdout).toEqual(['Done']);
      if (format === 'json') expect(JSON.parse(output.stdout[0] ?? '')).toMatchObject({ ok: true });
      if (format === 'jsonl') expect(output.stdout).toHaveLength(2);
    }
  });

  it('never waits for approval input and uses a stable exit code', async () => {
    const session = new FakeSession([
      [{ type: 'approval', approvalId: 'approval-2', reason: 'Deploy', ruleId: 'ask-external' }],
    ]);
    const output = capture();
    const code = await new HeadlessExecutor(session).execute('deploy', output.output, {
      format: 'json',
      approval: 'deny',
    });
    expect(code).toBe(FORGE_EXIT_CODES.approvalRequired);
    expect(session.commands).toEqual(['permissions deny approval-2']);
    expect(session.cancelled).toBe(true);
    expect(JSON.parse(output.stdout[0] ?? '')).toMatchObject({ approvalRequired: true });
  });
});
