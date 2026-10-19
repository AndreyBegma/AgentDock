import { describe, expect, it } from 'bun:test';
import { cardRecommendationOf } from './recommendation';

const none = {
  recommendedModel: null,
  recommendedEffort: null,
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
        recommendedEffort: 'low',
        recommendedReason: 'Executes a clear decision.',
        recommendedDesignModel: 'opus',
        recommendedDesignReason: 'The layout is open.',
        assessedAt: new Date('2026-10-15T10:00:00.000Z'),
      }),
    ).toEqual({
      work: {
        model: 'sonnet',
        effort: 'low',
        reason: 'Executes a clear decision.',
      },
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

  it('reads a missing or unknown effort as none, keeping the model (#663)', () => {
    const withEffort = (recommendedEffort: string | null) =>
      cardRecommendationOf({
        ...none,
        recommendedModel: 'opus',
        recommendedReason: 'x',
        recommendedEffort,
      }).work;
    expect(withEffort(null)).toEqual({
      model: 'opus',
      effort: null,
      reason: 'x',
    });
    expect(withEffort('max')?.effort).toBeNull();
    expect(withEffort('high')?.effort).toBe('high');
  });
});
