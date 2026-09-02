import { serviceToken } from '@forge/kernel-contracts';

export const plugin = {
  manifest: {
    apiVersion: 'forge.dev/v1',
    name: 'valid-consumer',
    version: '1.0.0',
    runtime: 'trusted',
    entrypoint: './plugin.mjs',
    requires: { 'core.service': '^1.0.0' },
    provides: ['app.service'],
  },
  setup(context) {
    const dependency = context.get(serviceToken('core.service'));
    context.provide(serviceToken('app.service'), { dependency });
  },
};
