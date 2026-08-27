import { type ForgeError, pluginName, serviceToken } from '@forge/kernel-contracts';
import { describe, expect, it } from 'vitest';
import { createForgeContext } from './index.js';

describe('Forge context services', () => {
  it('provides exclusive services and reports missing services', () => {
    const context = createForgeContext();
    const logger = serviceToken<{ name: string }>('forge.logger');
    const missing = serviceToken<string>('forge.missing');

    context.provide(logger, { name: 'root' });

    expect(context.get(logger)).toEqual({ name: 'root' });
    expect(context.optional(missing)).toBeUndefined();
    expect(() => context.get(missing)).toThrowError(
      expect.objectContaining({ code: 'MISSING_SERVICE' }),
    );
  });

  it('inherits and shadows exclusive services without changing parent or sibling scopes', () => {
    const root = createForgeContext();
    const theme = serviceToken<string>('forge.theme');
    root.provide(theme, 'root');

    const child = root.scope({ name: 'child' });
    const sibling = root.scope({ name: 'sibling' });
    expect(child.get(theme)).toBe('root');

    child.provide(theme, 'child');

    expect(child.get(theme)).toBe('child');
    expect(root.get(theme)).toBe('root');
    expect(sibling.get(theme)).toBe('root');
  });

  it('rejects duplicate exclusive providers in one scope', () => {
    const context = createForgeContext();
    const service = serviceToken<number>('forge.exclusive');
    context.provide(service, 1);

    expect(() => context.provide(service, 2)).toThrowError(
      expect.objectContaining({ code: 'SERVICE_CONFLICT' }),
    );
  });

  it('rejects conflicting cardinalities for one service identifier', () => {
    const context = createForgeContext();
    const exclusive = serviceToken<string>('forge.cardinality');
    const multiple = serviceToken<string>('forge.cardinality', 'multiple');
    context.provide(exclusive, 'exclusive');

    expect(() => context.provide(multiple, 'multiple')).toThrowError(
      expect.objectContaining({ code: 'SERVICE_CONFLICT' }),
    );
    expect(() => context.optional(multiple)).toThrowError(
      expect.objectContaining({ code: 'SERVICE_CONFLICT' }),
    );
  });

  it('composes multi-provider services from root to leaf in registration order', () => {
    const root = createForgeContext();
    const middleware = serviceToken<string>('forge.middleware', 'multiple');
    expect(root.optional(middleware)).toEqual([]);
    expect(() => root.get(middleware)).toThrowError(
      expect.objectContaining({ code: 'MISSING_SERVICE' }),
    );

    root.provide(middleware, 'root:first');
    root.provide(middleware, 'root:second');
    const child = root.scope({ name: 'child' });
    child.provide(middleware, 'child:first');

    expect(child.get(middleware)).toEqual(['root:first', 'root:second', 'child:first']);
    expect(root.get(middleware)).toEqual(['root:first', 'root:second']);
    expect(Object.isFrozen(child.get(middleware))).toBe(true);
  });

  it('removes an individual provider when its registration is disposed', async () => {
    const context = createForgeContext();
    const service = serviceToken<string>('forge.disposable');
    const registration = context.provide(service, 'active');

    await registration.dispose();
    await registration.dispose();

    expect(context.optional(service)).toBeUndefined();
  });
});

describe('Forge context lifecycle', () => {
  it('cascades disposal and unwinds effects in reverse registration order', async () => {
    const root = createForgeContext();
    const child = root.scope({ name: 'child' });
    const cleanup: string[] = [];
    root.effect(() => {
      cleanup.push('root:first');
    });
    root.effect(() => {
      cleanup.push('root:second');
    });
    child.effect(() => {
      cleanup.push('child:first');
    });

    await root.dispose();
    await root.dispose();

    expect(cleanup).toEqual(['child:first', 'root:second', 'root:first']);
    expect(root.disposed).toBe(true);
    expect(child.disposed).toBe(true);
  });

  it('rejects operations after disposal', async () => {
    const context = createForgeContext();
    const service = serviceToken<string>('forge.closed');
    await context.dispose();

    const operations = [
      () => context.provide(service, 'value'),
      () => context.get(service),
      () => context.optional(service),
      () => context.effect(() => undefined),
      () => context.scope({ name: 'late-child' }),
      () => context.inspectServices(),
    ];

    for (const operation of operations) {
      expect(operation).toThrowError(expect.objectContaining({ code: 'CONTEXT_DISPOSED' }));
    }
  });

  it('rejects empty scope names', () => {
    const root = createForgeContext();
    expect(() => root.scope({ name: '  ' })).toThrowError(
      expect.objectContaining({ code: 'INVARIANT_VIOLATION' }),
    );
  });

  it('continues cleanup and reports aggregated disposal failures', async () => {
    const context = createForgeContext();
    const cleanup: string[] = [];
    context.effect(() => {
      cleanup.push('first');
    });
    context.effect(() => {
      cleanup.push('failing');
      throw new Error('cleanup failed');
    });
    context.effect(() => {
      cleanup.push('last');
    });

    await expect(context.dispose()).rejects.toMatchObject({
      code: 'CONTEXT_DISPOSE_FAILED',
      details: { errorCount: 1 },
    } satisfies Partial<ForgeError>);
    expect(cleanup).toEqual(['last', 'failing', 'first']);
  });
});

describe('Forge service graph inspection', () => {
  it('describes active scopes and providers without exposing service values', async () => {
    const root = createForgeContext('workspace');
    const tools = serviceToken<{ secret: string }>('forge.tools', 'multiple');
    const rootProvider = root.provide(tools, { secret: 'root-secret' });
    const child = root.scope({ name: 'plugin', parentPlugin: pluginName('example-plugin') });
    child.provide(tools, { secret: 'child-secret' });

    const graph = root.inspectServices();
    expect(graph.rootScopeId).toBe(root.id);
    expect(graph.scopes).toEqual([
      {
        id: root.id,
        name: 'workspace',
        parentId: undefined,
        parentPlugin: undefined,
      },
      {
        id: child.id,
        name: 'plugin',
        parentId: root.id,
        parentPlugin: 'example-plugin',
      },
    ]);
    expect(graph.services).toEqual([
      {
        id: 'forge.tools',
        cardinality: 'multiple',
        providers: [
          { registrationId: 'registration-1', scopeId: root.id },
          { registrationId: 'registration-2', scopeId: child.id },
        ],
      },
    ]);
    expect(JSON.stringify(graph)).not.toContain('secret');
    expect(Object.isFrozen(graph)).toBe(true);

    await rootProvider.dispose();
    await child.dispose();
    expect(root.inspectServices()).toEqual({
      rootScopeId: root.id,
      scopes: [
        {
          id: root.id,
          name: 'workspace',
          parentId: undefined,
          parentPlugin: undefined,
        },
      ],
      services: [],
    });
  });
});
