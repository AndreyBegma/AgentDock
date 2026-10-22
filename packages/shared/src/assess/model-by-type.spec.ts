import { describe, expect, it } from 'bun:test';
import { CARD_DECIDING_SIGNALS, CARD_EFFORTS } from './limits';
import { effectiveWorkClass, modelByType } from './model-by-type';

describe('effectiveWorkClass (#750 D2)', () => {
  it('keeps the class without a signal', () => {
    expect(effectiveWorkClass('mechanical', [])).toBe('mechanical');
    expect(effectiveWorkClass('unsure', [])).toBe('unsure');
    expect(effectiveWorkClass('deciding', [])).toBe('deciding');
  });

  it('makes every signal deciding, whatever the model said', () => {
    for (const signal of CARD_DECIDING_SIGNALS) {
      expect(effectiveWorkClass('mechanical', [signal])).toBe('deciding');
      expect(effectiveWorkClass('unsure', [signal])).toBe('deciding');
    }
  });
});

describe('modelByType (#750 D3)', () => {
  it('runs deciding work on opus at high', () => {
    for (const effort of [...CARD_EFFORTS, null]) {
      expect(modelByType('deciding', effort, false)).toEqual({
        model: 'opus',
        effort: 'high',
      });
    }
  });

  it('runs unsure work, and a card with no class, on opus at medium', () => {
    expect(modelByType('unsure', 'low', false)).toEqual({
      model: 'opus',
      effort: 'medium',
    });
    expect(modelByType(null, null, false)).toEqual({
      model: 'opus',
      effort: 'medium',
    });
  });

  it('runs mechanical work on sonnet at the assessed effort, capped at medium', () => {
    expect(modelByType('mechanical', 'low', false)).toEqual({
      model: 'sonnet',
      effort: 'low',
    });
    expect(modelByType('mechanical', 'medium', false)).toEqual({
      model: 'sonnet',
      effort: 'medium',
    });
    expect(modelByType('mechanical', 'high', false)).toEqual({
      model: 'sonnet',
      effort: 'medium',
    });
    expect(modelByType('mechanical', null, false)).toEqual({
      model: 'sonnet',
      effort: 'medium',
    });
  });

  it('keeps a ci_fix round on sonnet at low for every class', () => {
    for (const workClass of [
      'mechanical',
      'deciding',
      'unsure',
      null,
    ] as const) {
      expect(modelByType(workClass, 'high', true)).toEqual({
        model: 'sonnet',
        effort: 'low',
      });
    }
  });

  it('never resolves to haiku', () => {
    for (const workClass of [
      'mechanical',
      'deciding',
      'unsure',
      null,
    ] as const) {
      for (const effort of [...CARD_EFFORTS, null]) {
        for (const ciFix of [false, true]) {
          expect(modelByType(workClass, effort, ciFix).model).not.toBe('haiku');
        }
      }
    }
  });
});
