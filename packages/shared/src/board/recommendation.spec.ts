import { describe, expect, it } from 'bun:test';
import { cardRecommendationOf } from './recommendation';

const none = {
  recommendedModel: null,
  recommendedReason: null,
  recommendedDesignModel: null,
  recommendedDesignReason: null,
  assessedAt: null,
};

describe('cardRecommendationOf', () => {
  it('is empty before an assessment (D7)', () => {
    expect(cardRecommendationOf(none)).toEqual({
      work: null,
      design: null,
      assessedAt: null,
    });
  });

  it('reads both recommendations and when they applied', () => {
    expect(
      cardRecommendationOf({
        recommendedModel: 'sonnet',
        recommendedReason: 'Executes a clear decision.',
        recommendedDesignModel: 'opus',
        recommendedDesignReason: 'The layout is open.',
        assessedAt: new Date('2026-10-15T10:00:00.000Z'),
      }),
    ).toEqual({
      work: { model: 'sonnet', reason: 'Executes a clear decision.' },
      design: { model: 'opus', reason: 'The layout is open.' },
      assessedAt: '2026-10-15T10:00:00.000Z',
    });
  });

  it('reads a model the contract does not allow, or one without a reason, as none', () => {
    const view = cardRecommendationOf({
      ...none,
      recommendedModel: 'fable',
      recommendedReason: 'x',
      recommendedDesignModel: 'haiku',
      recommendedDesignReason: 'x',
    });
    expect(view.work).toBeNull();
    expect(view.design).toBeNull();
    expect(
      cardRecommendationOf({ ...none, recommendedModel: 'opus' }).work,
    ).toBeNull();
  });
});
