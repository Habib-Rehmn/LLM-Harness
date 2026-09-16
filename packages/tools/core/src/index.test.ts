import { describe, expect, it } from 'vitest';
import {
  ToolPipeline,
  ToolRegistry,
  type Tool,
  type ToolDefinition,
  type ToolGuard,
} from './index.js';

const allow: ToolGuard = { evaluate: () => ({ decision: 'allow' }) };

function definition(name: string, overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    version: '1.0.0',
    description: `Run ${name}`,
    inputSchema: {
      type: 'object',
      required: ['value'],
      properties: { value: { type: 'number' } },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      required: ['answer'],
      properties: { answer: { type: 'number' } },
      additionalProperties: false,
    },
    capabilities: [],
    risk: 'safe',
    readOnly: true,
    idempotent: true,
    timeoutMs: 100,
    maxOutputBytes: 80,
    origin: 'official-plugin',
    ...overrides,
  };
}

function tool(name: string, overrides: Partial<ToolDefinition> = {}): Tool {
  return {
    definition: definition(name, overrides),
    async execute(arguments_) {
      const value = arguments_.value;
      return { text: `answer=${value}`, data: { answer: Number(value) * 2 } };
    },
  };
}

const execution = { workspaceRoot: '/workspace', mode: 'code' } as const;

describe('tool registry', () => {
  it('discovers, restricts, lazily reveals, and presents the same definitions', () => {
    const registry = new ToolRegistry();
    registry.register(tool('read_file'));
    registry.register(
      tool('delete_cache', {
        readOnly: false,
        risk: 'destructive',
        visibility: 'lazy',
        keywords: ['cleanup'],
      }),
    );

    expect(registry.present()).toEqual([
      expect.objectContaining({ name: 'read_file', inputSchema: expect.any(Object) }),
    ]);
    expect(registry.discover({ query: 'cleanup' }).map(({ name }) => name)).toEqual([
      'delete_cache',
      'read_file',
    ]);
    expect(
      registry
        .discover({ includeLazy: true, restriction: { readOnly: true } })
        .map(({ name }) => name),
    ).toEqual(['read_file']);
  });
});

describe('guarded tool pipeline', () => {
  it('keeps presentation, lookup, policy, wrappers, execution, and recording aligned', async () => {
    const registry = new ToolRegistry();
    registry.register(tool('double'));
    const stages: string[] = [];
    const pipeline = new ToolPipeline(
      registry,
      {
        evaluate(call) {
          stages.push(`guard:${call.name}:${call.arguments.value}`);
          return { decision: 'allow' };
        },
      },
      {
        preExecute: [
          (call) => {
            stages.push('pre');
            return { ...call, arguments: { value: 2 } };
          },
        ],
        wrappers: [
          async (_call, next) => {
            stages.push('wrapper:before');
            const output = await next();
            stages.push('wrapper:after');
            return output;
          },
        ],
        postExecute: [(_call, result) => void stages.push(`post:${result.ok}`)],
        recordResult: (call, result) => void stages.push(`record:${call.name}:${result.ok}`),
      },
    );

    const result = await pipeline.execute(
      { callId: 'call-1', name: 'double', arguments: { value: 1 } },
      execution,
    );
    expect(result).toMatchObject({
      ok: true,
      name: 'double',
      version: '1.0.0',
      origin: 'official-plugin',
      arguments: { value: 2 },
      text: 'answer=2',
      data: { answer: 4 },
      policy: { decision: 'allow' },
    });
    expect(stages).toEqual([
      'pre',
      'guard:double:2',
      'wrapper:before',
      'wrapper:after',
      'post:true',
      'record:double:true',
    ]);
  });

  it('normalizes lookup, validation, policy, execution, output, timeout, and cancellation failures', async () => {
    const registry = new ToolRegistry();
    registry.register(tool('double'));
    registry.register({
      definition: definition('explode'),
      async execute() {
        throw new Error('boom');
      },
    });
    registry.register({
      definition: definition('invalid_output'),
      async execute() {
        return { text: 'bad', data: { wrong: true } };
      },
    });
    registry.register({
      definition: definition('slow', { timeoutMs: 5 }),
      async execute() {
        return new Promise(() => undefined);
      },
    });
    const recorded: string[] = [];
    const pipeline = new ToolPipeline(registry, allow, {
      recordResult: (_call, result) => void recorded.push(result.error?.code ?? 'OK'),
    });

    const cases = await Promise.all([
      pipeline.execute({ callId: '1', name: 'missing', arguments: {} }, execution),
      pipeline.execute({ callId: '2', name: 'double', arguments: { value: 'bad' } }, execution),
      pipeline.execute({ callId: '3', name: 'explode', arguments: { value: 1 } }, execution),
      pipeline.execute({ callId: '4', name: 'invalid_output', arguments: { value: 1 } }, execution),
      pipeline.execute({ callId: '5', name: 'slow', arguments: { value: 1 } }, execution),
    ]);
    expect(cases.map((result) => result.error?.code)).toEqual([
      'NOT_FOUND',
      'INVALID_ARGUMENTS',
      'EXECUTION_FAILED',
      'INVALID_RESULT',
      'TIMEOUT',
    ]);
    expect(recorded.sort()).toEqual(
      ['NOT_FOUND', 'INVALID_ARGUMENTS', 'EXECUTION_FAILED', 'INVALID_RESULT', 'TIMEOUT'].sort(),
    );

    const denied = new ToolPipeline(registry, {
      evaluate: () => ({ decision: 'deny', reason: 'blocked by policy' }),
    });
    expect(
      await denied.execute({ callId: '6', name: 'double', arguments: { value: 1 } }, execution),
    ).toMatchObject({ error: { code: 'DENIED' }, policy: { decision: 'deny' } });

    const controller = new AbortController();
    controller.abort();
    expect(
      await pipeline.execute(
        { callId: '7', name: 'double', arguments: { value: 1 } },
        { ...execution, signal: controller.signal },
      ),
    ).toMatchObject({ error: { code: 'CANCELLED' } });
  });

  it('truncates Unicode safely with head/tail context and preserves artifacts', async () => {
    const registry = new ToolRegistry();
    registry.register({
      definition: definition('large', { outputSchema: {}, maxOutputBytes: 52, maxOutputLines: 4 }),
      async execute() {
        return {
          text: 'first 🌍\nsecond\nthird\nfourth\nfifth ✅',
          artifacts: [{ type: 'full-output', uri: 'memory://result/1', sizeBytes: 48 }],
        };
      },
    });
    const result = await new ToolPipeline(registry, allow).execute(
      { callId: 'large-1', name: 'large', arguments: { value: 1 } },
      execution,
    );
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(52);
    expect(result.artifacts).toEqual([
      { type: 'full-output', uri: 'memory://result/1', sizeBytes: 48 },
    ]);
  });

  it('runs adjacent read-only calls concurrently and puts writes behind barriers', async () => {
    const registry = new ToolRegistry();
    const order: string[] = [];
    for (const [name, readOnly] of [
      ['read_a', true],
      ['read_b', true],
      ['write', false],
      ['read_c', true],
    ] as const) {
      registry.register({
        definition: definition(name, { readOnly, outputSchema: {} }),
        async execute() {
          order.push(`start:${name}`);
          await Promise.resolve();
          order.push(`end:${name}`);
          return { text: name };
        },
      });
    }
    const calls = ['read_a', 'read_b', 'write', 'read_c'].map((name, index) => ({
      callId: String(index),
      name,
      arguments: { value: index },
    }));
    const results = await new ToolPipeline(registry, allow).executeBatch(calls, execution);
    expect(results.map(({ name }) => name)).toEqual(['read_a', 'read_b', 'write', 'read_c']);
    expect(order).toEqual([
      'start:read_a',
      'start:read_b',
      'end:read_a',
      'end:read_b',
      'start:write',
      'end:write',
      'start:read_c',
      'end:read_c',
    ]);
  });
});
