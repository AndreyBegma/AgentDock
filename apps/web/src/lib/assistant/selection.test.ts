import { describe, expect, test } from 'bun:test';
import { modelKey, parseModelKey } from './selection';

describe('model key', () => {
  test('round-trips a provider and a model, even with a colon in the model', () => {
    const key = modelKey('openrouter', 'anthropic/claude:beta');
    expect(parseModelKey(key)).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude:beta',
    });
  });

  test('the instance default is the empty key both ways', () => {
    expect(modelKey(null, null)).toBe('');
    expect(parseModelKey('')).toEqual({ provider: null, model: null });
  });

  test('an unknown provider reads as the default', () => {
    expect(parseModelKey('nope::x')).toEqual({ provider: null, model: null });
  });
});
