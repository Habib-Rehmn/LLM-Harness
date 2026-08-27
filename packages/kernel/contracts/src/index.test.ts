import { describe, expect, it } from 'vitest';
import { FORGE_API_VERSION, ForgeError, cancellation, pluginName, serviceToken } from './index.js';

describe('kernel contracts', () => {
  it('creates stable service tokens', () => {
    const token = serviceToken<{ answer: number }>('answer-service');
    expect(token).toEqual({ id: 'answer-service', cardinality: 'exclusive' });
    expect(Object.isFrozen(token)).toBe(true);
  });

  it('supports namespaced service identifiers and typed cardinality', () => {
    const token = serviceToken<string>('forge.context-provider', 'multiple');
    expect(token).toEqual({ id: 'forge.context-provider', cardinality: 'multiple' });
  });

  it('rejects unstable plugin identifiers', () => {
    expect(() => pluginName('Bad Plugin')).toThrowError(ForgeError);
    expect(pluginName('example-plugin')).toBe('example-plugin');
  });

  it('provides a versioned API constant', () => {
    expect(FORGE_API_VERSION).toBe('forge.dev/v1');
  });

  it('propagates cancellation with a typed error', () => {
    const controller = new AbortController();
    const token = cancellation(controller.signal);
    controller.abort('test');
    expect(() => token.throwIfCancelled()).toThrowError(
      expect.objectContaining({ code: 'CANCELLED' }),
    );
  });
});
