import { describe, expect, it } from 'vitest';
import { runInterceptionChain } from './index.js';

describe('interception chain example', () => {
  it('delegates, denies monotonically, and unloads without listener leaks', async () => {
    await expect(runInterceptionChain()).resolves.toEqual({
      decision: 'deny',
      trace: ['observed:shell', 'managed-policy'],
      listenersBeforeUnload: 2,
      listenersAfterUnload: 0,
    });
  });
});
