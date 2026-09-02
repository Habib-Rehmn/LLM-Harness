import { serviceToken } from '@forge/kernel-contracts';

export const plugin = {
  manifest: {
    apiVersion: 'forge.dev/v1',
    name: 'valid-provider',
    version: '1.2.0',
    runtime: 'trusted',
    entrypoint: './plugin.mjs',
    provides: ['core.service'],
  },
  setup(context) {
    context.provide(serviceToken('core.service'), { value: 'provider' });
  },
};
