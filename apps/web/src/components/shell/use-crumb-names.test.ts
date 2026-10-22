import { describe, expect, test } from 'bun:test';
import { detailOf } from './use-crumb-names';

describe('the breadcrumb GET for a detail page (C-165)', () => {
  test('a plan page reads its plan', () => {
    expect(detailOf('/projects/p1/planner/c2')).toEqual({
      id: 'c2',
      path: '/projects/p1/plans/c2',
    });
  });

  test('an encoded ../ stays inside its segment', () => {
    expect(detailOf('/projects/p1/planner/a%2F..%2Fb')?.path).toBe(
      '/projects/p1/plans/a%2F..%2Fb',
    );
    expect(detailOf('/sessions/..%2Fadmin')?.path).toBe('/sessions/..%2Fadmin');
  });

  test('a segment that does not decode makes no GET', () => {
    expect(detailOf('/projects/p1/skills/runs/%E0%A4%A')).toBeNull();
  });
});
