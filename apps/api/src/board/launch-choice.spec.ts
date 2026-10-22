import { ORCHESTRATOR_DEFAULTS } from '@nautelle/shared/protocol';
import {
  defaultCardLaunch,
  defaultCardModel,
  isOpusModel,
  rememberedChoice,
} from './launch-choice';

describe('defaultCardModel (#322 D2)', () => {
  it('takes the recommendation first', () => {
    expect(defaultCardModel('sonnet', 'opus')).toBe('sonnet');
  });

  it('falls back to the project model, then the default', () => {
    expect(defaultCardModel(null, 'haiku')).toBe('haiku');
    expect(defaultCardModel(null, null)).toBe(ORCHESTRATOR_DEFAULTS.model);
  });
});

describe('defaultCardLaunch (#663)', () => {
  const opusHigh = { model: 'opus', effort: 'high' } as const;

  it('runs a ci_fix round on sonnet at low, whatever was recommended', () => {
    expect(defaultCardLaunch(true, opusHigh, 'opus')).toEqual({
      model: 'sonnet',
      effort: 'low',
    });
  });

  it('takes the recommendation’s model and effort for any other round', () => {
    expect(defaultCardLaunch(false, opusHigh, 'sonnet')).toEqual(opusHigh);
    expect(
      defaultCardLaunch(false, { model: 'haiku', effort: null }, 'opus'),
    ).toEqual({ model: 'haiku', effort: null });
  });

  it('without a recommendation, the project model and no effort', () => {
    expect(defaultCardLaunch(false, null, 'haiku')).toEqual({
      model: 'haiku',
      effort: null,
    });
  });
});

describe('defaultCardLaunch by card class (#750 D3, D4)', () => {
  const assessed = { model: 'haiku', effort: 'low' } as const;

  it('runs a mechanical card on sonnet at the assessed effort in the B arm, and as today in the A arm', () => {
    expect(
      defaultCardLaunch(false, assessed, 'opus', { workClass: 'mechanical' }),
    ).toEqual({ model: 'sonnet', effort: 'low' });
    expect(
      defaultCardLaunch(false, { model: 'sonnet', effort: 'high' }, 'opus', {
        workClass: 'mechanical',
      }),
    ).toEqual({ model: 'sonnet', effort: 'medium' });
    expect(defaultCardLaunch(false, assessed, 'opus')).toEqual(assessed);
  });

  it('runs a deciding card on opus at high', () => {
    expect(
      defaultCardLaunch(false, assessed, 'sonnet', { workClass: 'deciding' }),
    ).toEqual({ model: 'opus', effort: 'high' });
  });

  it('runs an unsure card, or one with no assessment, on opus at medium', () => {
    expect(
      defaultCardLaunch(false, assessed, 'sonnet', { workClass: 'unsure' }),
    ).toEqual({ model: 'opus', effort: 'medium' });
    expect(
      defaultCardLaunch(false, null, 'haiku', { workClass: null }),
    ).toEqual({ model: 'opus', effort: 'medium' });
  });

  it('keeps a ci_fix round on sonnet at low in both arms', () => {
    for (const byType of [null, { workClass: 'deciding' as const }]) {
      expect(
        defaultCardLaunch(
          true,
          { model: 'opus', effort: 'high' },
          'opus',
          byType,
        ),
      ).toEqual({ model: 'sonnet', effort: 'low' });
    }
  });

  it('a person’s choice is remembered against the mapped default (#322 D3)', () => {
    const mapped = defaultCardLaunch(false, assessed, 'opus', {
      workClass: 'mechanical',
    });
    expect(rememberedChoice('sonnet', mapped.model)).toBeNull();
    expect(rememberedChoice('opus', mapped.model)).toBe('opus');
    expect(rememberedChoice('haiku', mapped.model)).toBe('haiku');
  });
});

describe('isOpusModel (#750 D8)', () => {
  it('knows an alias and a full id', () => {
    expect(isOpusModel('opus')).toBe(true);
    expect(isOpusModel('claude-opus-5-5')).toBe(true);
    expect(isOpusModel('sonnet')).toBe(false);
    expect(isOpusModel('haiku')).toBe(false);
  });
});

describe('rememberedChoice (#322 D3)', () => {
  it('stores nothing when nothing was sent', () => {
    expect(rememberedChoice(undefined, 'sonnet')).toBeUndefined();
  });

  it('clears the override when the choice is the default', () => {
    expect(rememberedChoice('sonnet', 'sonnet')).toBeNull();
  });

  it('remembers a choice that differs from the default', () => {
    expect(rememberedChoice('opus', 'sonnet')).toBe('opus');
    expect(rememberedChoice('claude-main', null)).toBe('claude-main');
  });
});
