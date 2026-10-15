import { ORCHESTRATOR_DEFAULTS } from '@agentdock/shared/protocol';
import { defaultCardModel, rememberedChoice } from './launch-choice';

describe('defaultCardModel (#322 D2)', () => {
  it('takes the recommendation first', () => {
    expect(defaultCardModel('sonnet', 'opus')).toBe('sonnet');
  });

  it('falls back to the project model, then the default', () => {
    expect(defaultCardModel(null, 'haiku')).toBe('haiku');
    expect(defaultCardModel(null, null)).toBe(ORCHESTRATOR_DEFAULTS.model);
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
