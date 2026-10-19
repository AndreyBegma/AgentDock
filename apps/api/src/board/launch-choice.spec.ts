import { ORCHESTRATOR_DEFAULTS } from '@agentdock/shared/protocol';
import {
  defaultCardLaunch,
  defaultCardModel,
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
