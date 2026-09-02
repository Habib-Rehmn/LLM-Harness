import { fileURLToPath } from 'node:url';
import { createForgeContext } from '@forge/kernel-context';
import { type ForgeContext, pluginName, serviceToken } from '@forge/kernel-contracts';
import { describe, expect, it } from 'vitest';
import { ForgePluginLoader, discoverPlugins, resolvePluginGraph } from './index.js';

function fixture(name: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

describe('plugin manifest discovery', () => {
  it('discovers and validates plugins without executing entrypoints', async () => {
    let imports = 0;
    const root = createForgeContext();
    const loader = new ForgePluginLoader(root, {
      importer: async () => {
        imports += 1;
        return {};
      },
    });

    const plugins = await loader.discover([
      fixture('valid-consumer'),
      fixture('alpha-observer'),
      fixture('valid-provider'),
    ]);

    expect(plugins.map((plugin) => plugin.manifest.name)).toEqual([
      'alpha-observer',
      'valid-consumer',
      'valid-provider',
    ]);
    expect(imports).toBe(0);
    expect(root.optional(serviceToken('core.service'))).toBeUndefined();
  });

  it('rejects malformed and incompatible manifests before execution', async () => {
    await expect(discoverPlugins([fixture('malformed-plugin')])).rejects.toMatchObject({
      code: 'INVALID_MANIFEST',
    });
    await expect(discoverPlugins([fixture('incompatible-api')])).rejects.toMatchObject({
      code: 'INCOMPATIBLE_API',
    });
    await expect(discoverPlugins([fixture('escape-plugin')])).rejects.toMatchObject({
      code: 'INVALID_MANIFEST',
    });
  });
});

describe('plugin dependency graph', () => {
  it('sorts providers before consumers and independent plugins by name', async () => {
    const plugins = await discoverPlugins([
      fixture('valid-consumer'),
      fixture('valid-provider'),
      fixture('alpha-observer'),
    ]);

    const plan = resolvePluginGraph(plugins);

    expect(plan.plugins.map((node) => node.plugin.manifest.name)).toEqual([
      'alpha-observer',
      'valid-provider',
      'valid-consumer',
    ]);
    expect(plan.plugins[2]?.dependencies).toEqual(['valid-provider']);
  });

  it('rejects cycles and incompatible service ranges before importing code', async () => {
    const cyclic = await discoverPlugins([fixture('cycle-a'), fixture('cycle-b')]);
    expect(() => resolvePluginGraph(cyclic)).toThrowError(
      expect.objectContaining({ code: 'DEPENDENCY_CYCLE' }),
    );

    const incompatible = await discoverPlugins([
      fixture('valid-provider'),
      fixture('incompatible-consumer'),
    ]);
    expect(() => resolvePluginGraph(incompatible)).toThrowError(
      expect.objectContaining({ code: 'INCOMPATIBLE_SERVICE' }),
    );
  });

  it('rejects missing requirements and duplicate exclusive providers', async () => {
    const [provider, consumer] = await Promise.all([
      discoverPlugins([fixture('valid-provider')]),
      discoverPlugins([fixture('valid-consumer')]),
    ]);
    expect(() => resolvePluginGraph(consumer)).toThrowError(
      expect.objectContaining({ code: 'MISSING_SERVICE' }),
    );

    const original = provider[0];
    if (!original) throw new Error('provider fixture is missing');
    const duplicate = Object.freeze({
      ...original,
      manifest: Object.freeze({
        ...original.manifest,
        name: pluginName('second-provider'),
      }),
    });
    expect(() => resolvePluginGraph([original, duplicate])).toThrowError(
      expect.objectContaining({ code: 'SERVICE_CONFLICT' }),
    );
  });

  it('accepts compatible external services without adding plugin edges', async () => {
    const consumer = await discoverPlugins([fixture('valid-consumer')]);
    const plan = resolvePluginGraph(consumer, {
      externalServices: { 'core.service': '1.5.0' },
    });
    expect(plan.plugins[0]?.dependencies).toEqual([]);
  });
});

describe('plugin activation lifecycle', () => {
  it('never imports process-runtime plugins into the trusted host', async () => {
    const root = createForgeContext();
    let imports = 0;
    const loader = new ForgePluginLoader(root, {
      importer: async () => {
        imports += 1;
        return {};
      },
    });
    const processPlugin = await loader.discover([fixture('process-plugin')]);

    await expect(loader.activate(loader.resolve(processPlugin))).rejects.toMatchObject({
      code: 'PLUGIN_LOAD_FAILED',
    });
    expect(imports).toBe(0);
  });

  it('loads real fixture modules and cascades dependent unloads', async () => {
    const root = createForgeContext();
    const loader = new ForgePluginLoader(root);

    const plan = await loader.load([
      fixture('valid-consumer'),
      fixture('valid-provider'),
      fixture('alpha-observer'),
    ]);

    expect(plan.plugins.map((node) => node.plugin.manifest.name)).toEqual([
      'alpha-observer',
      'valid-provider',
      'valid-consumer',
    ]);
    expect(loader.activePlugins).toEqual(['alpha-observer', 'valid-provider', 'valid-consumer']);
    expect(root.get(serviceToken<{ value: string }>('core.service'))).toEqual({
      value: 'provider',
    });
    expect(root.get(serviceToken<{ dependency: unknown }>('app.service'))).toEqual({
      dependency: { value: 'provider' },
    });

    await loader.unload('valid-provider');
    expect(loader.activePlugins).toEqual(['alpha-observer']);
    expect(root.optional(serviceToken('core.service'))).toBeUndefined();
    expect(root.optional(serviceToken('app.service'))).toBeUndefined();

    await loader.disable('alpha-observer');
    expect(loader.activePlugins).toEqual([]);
    expect(root.inspectServices().services).toEqual([]);
  });

  it('unwinds the current and previously active plugins after setup failure', async () => {
    const root = createForgeContext();
    const cleanup: string[] = [];
    const plugins = await discoverPlugins([fixture('valid-provider'), fixture('valid-consumer')]);
    const plan = resolvePluginGraph(plugins);
    const loader = new ForgePluginLoader(root, {
      importer: async (_entrypoint, discovered) => ({
        plugin: {
          manifest: discovered.manifest,
          setup(context: ForgeContext) {
            if (discovered.manifest.name === 'valid-provider') {
              context.provide(serviceToken('core.service'), 'provider');
              context.effect(() => {
                cleanup.push('provider');
              });
              return;
            }
            context.provide(serviceToken('app.service'), 'consumer');
            context.effect(() => {
              cleanup.push('consumer');
            });
            throw new Error('consumer setup failed');
          },
        },
      }),
    });

    await expect(loader.activate(plan)).rejects.toMatchObject({ code: 'PLUGIN_LOAD_FAILED' });
    expect(cleanup).toEqual(['consumer', 'provider']);
    expect(loader.activePlugins).toEqual([]);
    expect(root.inspectServices().services).toEqual([]);
  });

  it('rejects undeclared service registrations and unwinds them', async () => {
    const root = createForgeContext();
    const plugins = await discoverPlugins([fixture('alpha-observer')]);
    const loader = new ForgePluginLoader(root, {
      importer: async (_entrypoint, discovered) => ({
        plugin: {
          manifest: discovered.manifest,
          setup(context: ForgeContext) {
            context.provide(serviceToken('undeclared.service'), true);
          },
        },
      }),
    });

    await expect(loader.activate(resolvePluginGraph(plugins))).rejects.toMatchObject({
      code: 'PLUGIN_LOAD_FAILED',
    });
    expect(root.inspectServices().services).toEqual([]);
  });
});
