import {
  broadcastEvent,
  cancellation,
  decisionEvent,
  serialEvent,
  waterfallEvent,
} from '@forge/kernel-contracts';
import { describe, expect, it } from 'vitest';
import { createForgeContext } from './index.js';

describe('Forge broadcast events', () => {
  it('delivers to every listener and waits for asynchronous work', async () => {
    const context = createForgeContext();
    const event = broadcastEvent<{ value: string }>('agent.notice');
    const observed: string[] = [];
    context.on(event, async ({ value }) => {
      await Promise.resolve();
      observed.push(`first:${value}`);
    });
    context.on(event, ({ value }) => {
      observed.push(`second:${value}`);
    });

    await context.broadcast(event, { value: 'ready' });

    expect(observed).toEqual(['second:ready', 'first:ready']);
  });

  it('runs every listener and aggregates broadcast failures', async () => {
    const context = createForgeContext();
    const event = broadcastEvent<void>('agent.failure');
    const observed: string[] = [];
    context.on(event, () => {
      throw new Error('first failed');
    });
    context.on(event, () => {
      observed.push('second ran');
    });

    await expect(context.broadcast(event, undefined)).rejects.toBeInstanceOf(AggregateError);
    expect(observed).toEqual(['second ran']);
  });
});

describe('Forge serial events', () => {
  it('uses deterministic order and stops on the first defined result', async () => {
    const context = createForgeContext();
    const event = serialEvent<string, boolean>('tools.resolve');
    const observed: string[] = [];
    context.on(event, () => {
      observed.push('normal:first');
      return undefined;
    });
    context.on(
      event,
      () => {
        observed.push('prepended');
        return undefined;
      },
      { prepend: true },
    );
    context.on(event, () => {
      observed.push('answer');
      return false;
    });
    context.on(event, () => {
      observed.push('unreachable');
      return true;
    });

    await expect(context.serial(event, 'shell')).resolves.toBe(false);
    expect(observed).toEqual(['prepended', 'normal:first', 'answer']);
  });
});

describe('Forge waterfall events', () => {
  it('composes listeners around a terminal action with next()', async () => {
    const context = createForgeContext();
    const event = waterfallEvent<string, string>('tools.execute');
    const observed: string[] = [];
    context.on(event, async (input, next) => {
      observed.push(`first:before:${input}`);
      const result = await next();
      observed.push('first:after');
      return `${result}:first`;
    });
    context.on(event, async (_input, next) => {
      observed.push('second:before');
      const result = await next();
      observed.push('second:after');
      return `${result}:second`;
    });

    const result = await context.waterfall(event, 'command', () => {
      observed.push('terminal');
      return 'result';
    });

    expect(result).toBe('result:second:first');
    expect(observed).toEqual([
      'first:before:command',
      'second:before',
      'terminal',
      'second:after',
      'first:after',
    ]);
  });

  it('supports veto and rejects multiple next() calls', async () => {
    const vetoContext = createForgeContext();
    const vetoEvent = waterfallEvent<void, string>('tools.veto');
    vetoContext.on(vetoEvent, () => 'blocked');
    const terminal = () => 'executed';
    await expect(vetoContext.waterfall(vetoEvent, undefined, terminal)).resolves.toBe('blocked');

    const invalidContext = createForgeContext();
    const invalidEvent = waterfallEvent<void, string>('tools.invalid-next');
    invalidContext.on(invalidEvent, async (_payload, next) => {
      await next();
      return next();
    });
    await expect(invalidContext.waterfall(invalidEvent, undefined, terminal)).rejects.toMatchObject(
      { code: 'EVENT_NEXT_CALLED_MULTIPLE' },
    );
  });
});

describe('Forge monotonic decision events', () => {
  it('automatically delegates permissive decisions and preserves a downstream denial', async () => {
    const context = createForgeContext();
    const event = decisionEvent<{ command: string }>('tools.pre-execute');
    const observed: string[] = [];
    context.on(event, () => {
      observed.push('allow');
      return 'allow' as const;
    });
    context.on(event, async (_request, next) => {
      observed.push('delegate');
      return next();
    });
    context.on(event, () => {
      observed.push('deny');
      return 'deny' as const;
    });

    const result = await context.decide(event, { command: 'unsafe' }, () => {
      observed.push('terminal');
      return 'allow';
    });

    expect(result).toBe('deny');
    expect(observed).toEqual(['allow', 'delegate', 'deny']);
  });

  it('cannot widen a stricter decision returned by next()', async () => {
    const context = createForgeContext();
    const event = decisionEvent<void>('policy.check');
    context.on(event, async (_request, next) => {
      expect(await next()).toBe('deny');
      return 'allow' as const;
    });

    await expect(context.decide(event, undefined, () => 'deny')).resolves.toBe('deny');
  });
});

describe('Forge event cancellation and lifecycle', () => {
  it('propagates cancellation and stops a serial chain', async () => {
    const context = createForgeContext();
    const event = serialEvent<void, string>('agent.cancel');
    const controller = new AbortController();
    const token = cancellation(controller.signal);
    const observed: string[] = [];
    context.on(event, () => {
      observed.push('first');
      controller.abort('test cancellation');
      return undefined;
    });
    context.on(event, () => {
      observed.push('unreachable');
      return 'done';
    });

    await expect(context.serial(event, undefined, token)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(observed).toEqual(['first']);
  });

  it('rejects event identifier kind conflicts', () => {
    const context = createForgeContext();
    const broadcast = broadcastEvent<void>('agent.same-id');
    const serial = serialEvent<void, string>('agent.same-id');
    context.on(broadcast, () => undefined);

    expect(() => context.on(serial, () => 'answer')).toThrowError(
      expect.objectContaining({ code: 'EVENT_CONFLICT' }),
    );
  });

  it('removes scoped listeners after partial-failure cleanup', async () => {
    const root = createForgeContext();
    const plugin = root.scope({ name: 'plugin' });
    const event = broadcastEvent<string>('plugin.notice');
    const observed: string[] = [];
    plugin.on(event, (value) => {
      observed.push(value);
    });
    plugin.effect(() => {
      throw new Error('plugin cleanup failed');
    });

    await root.broadcast(event, 'active');
    expect(root.inspectEvents().events).toHaveLength(1);
    await expect(plugin.dispose()).rejects.toMatchObject({ code: 'CONTEXT_DISPOSE_FAILED' });
    expect(root.inspectEvents()).toEqual({ events: [] });
    await root.broadcast(event, 'disposed');
    expect(observed).toEqual(['active']);
  });

  it('tracks listener order and supports idempotent registration disposal', async () => {
    const context = createForgeContext();
    const event = broadcastEvent<{ secret: string }>('agent.inspect');
    const normal = context.on(event, () => undefined);
    context.on(event, () => undefined, { prepend: true });

    const graph = context.inspectEvents();
    expect(graph).toEqual({
      events: [
        {
          id: 'agent.inspect',
          kind: 'broadcast',
          listeners: [
            { registrationId: 'registration-2', scopeId: context.id },
            { registrationId: 'registration-1', scopeId: context.id },
          ],
        },
      ],
    });
    expect(JSON.stringify(graph)).not.toContain('secret');

    await normal.dispose();
    await normal.dispose();
    expect(context.inspectEvents().events[0]?.listeners).toHaveLength(1);
  });

  it('rejects event operations after context disposal', async () => {
    const context = createForgeContext();
    const broadcast = broadcastEvent<void>('closed.broadcast');
    const serial = serialEvent<void, string>('closed.serial');
    const waterfall = waterfallEvent<void, string>('closed.waterfall');
    const decision = decisionEvent<void>('closed.decision');
    await context.dispose();

    expect(() => context.on(broadcast, () => undefined)).toThrowError(
      expect.objectContaining({ code: 'CONTEXT_DISPOSED' }),
    );
    expect(() => context.inspectEvents()).toThrowError(
      expect.objectContaining({ code: 'CONTEXT_DISPOSED' }),
    );
    await expect(context.broadcast(broadcast, undefined)).rejects.toMatchObject({
      code: 'CONTEXT_DISPOSED',
    });
    await expect(context.serial(serial, undefined)).rejects.toMatchObject({
      code: 'CONTEXT_DISPOSED',
    });
    await expect(context.waterfall(waterfall, undefined, () => 'done')).rejects.toMatchObject({
      code: 'CONTEXT_DISPOSED',
    });
    await expect(context.decide(decision, undefined, () => 'allow')).rejects.toMatchObject({
      code: 'CONTEXT_DISPOSED',
    });
  });
});
