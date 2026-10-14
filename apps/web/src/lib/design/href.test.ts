import { describe, expect, test } from 'bun:test';
import { cardDesignApi, cardDesignHref, designApi, designHref } from './href';

describe('card design URLs (#243)', () => {
  test('the API is the card base, beside the task base', () => {
    expect(cardDesignApi('p1', 7)).toBe('/projects/p1/board/cards/7/design');
    expect(designApi('p1', 'plan-1', 't 1')).toBe(
      '/projects/p1/plans/plan-1/tasks/t%201/design',
    );
  });

  test('the viewer keeps its URL state', () => {
    expect(cardDesignHref('p1', 7)).toBe('/projects/p1/board/cards/7/design');
    expect(cardDesignHref('p1', 7, '?variant=2&theme=dark')).toBe(
      '/projects/p1/board/cards/7/design?variant=2&theme=dark',
    );
    expect(designHref('p1', 'plan-1', 't1')).toBe(
      '/projects/p1/planner/plan-1/tasks/t1/design',
    );
  });
});
