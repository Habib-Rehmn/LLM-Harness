import { FORGE_API_VERSION, type ForgePlugin, pluginName } from '@forge/kernel-contracts';

export const plugin: ForgePlugin = {
  manifest: {
    apiVersion: FORGE_API_VERSION,
    name: pluginName('contract-plugin'),
    version: '0.1.0',
    runtime: 'trusted',
    entrypoint: './lib/index.js',
    requires: { 'answer-service': '^1.0.0' },
    provides: ['example-greeting'],
    contributes: { examples: ['greeting'] },
    permissions: {},
  },
  setup(context) {
    context.effect(() => undefined);
  },
};
