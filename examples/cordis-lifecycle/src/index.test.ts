import { describe, expect, it } from 'vitest';
import { runCordisLifecycleSpike } from './index.js';

describe('Cordis lifecycle spike', () => {
  it('supports services, typed events, effects, and reverse disposal', async () => {
    const result = await runCordisLifecycleSpike();

    expect(result.greeting).toBe('hello from a scoped Cordis service');
    expect(result.observedMessages).toEqual(['plugin-active']);
    expect(result.cleanupOrder).toEqual(['second', 'first']);
    expect(result.liveEffectsBeforeDispose).toEqual(
      expect.arrayContaining(['forge-spike:first', 'forge-spike:second']),
    );
    expect(result.serviceAfterDispose).toBeUndefined();
  });
});
