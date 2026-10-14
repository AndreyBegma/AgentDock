import { describe, expect, test } from 'bun:test';
import { PLANNER_ERROR, type TaskRow } from '@agentdock/shared';
import { ApiError } from '../api';
import {
  describePlannerError,
  EMPTY_TASK_FILTERS,
  filtersFromSearch,
  filtersSearch,
  hasTaskFilters,
  mergeTaskRows,
  rowStatus,
  TASK_PILL_STATUS,
  TASK_STATUS_LABEL,
  TASK_STATUSES,
  taskFilterCount,
  taskPlannerHref,
  tasksQuery,
} from './format';

const row = (taskId: string): TaskRow => ({
  projectId: 'p 1',
  projectName: 'Project',
  planId: 'plan1',
  planTitle: 'Plan',
  taskId,
  key: 't3',
  title: 'Title',
  kind: 'bug',
  status: 'draft',
  issue: null,
  updatedAt: '2026-10-13T10:00:00.000Z',
});

describe('filters in the URL', () => {
  test('a round trip keeps every field, in a stable order', () => {
    const filters = {
      projectId: 'p1',
      kind: 'feature' as const,
      status: 'pr_open' as const,
      planId: 'plan1',
      q: 'login page',
    };
    const search = filtersSearch(filters);
    expect(search).toBe(
      '?projectId=p1&kind=feature&status=pr_open&planId=plan1&q=login+page',
    );
    expect(filtersFromSearch(new URLSearchParams(search))).toEqual(filters);
  });

  test('no filters is an empty search', () => {
    expect(filtersSearch(EMPTY_TASK_FILTERS)).toBe('');
    expect(hasTaskFilters(EMPTY_TASK_FILTERS)).toBe(false);
  });

  test('an unknown kind or status is dropped, not sent to the API', () => {
    const parsed = filtersFromSearch(
      new URLSearchParams('kind=epic&status=weird&q=x'),
    );
    expect(parsed).toEqual({ ...EMPTY_TASK_FILTERS, q: 'x' });
  });

  test('blank and oversized values are ignored', () => {
    const parsed = filtersFromSearch(
      new URLSearchParams(`q=%20%20&planId=${'a'.repeat(300)}`),
    );
    expect(parsed).toEqual(EMPTY_TASK_FILTERS);
  });

  test('the filter count is the number of fields set', () => {
    expect(
      taskFilterCount({ ...EMPTY_TASK_FILTERS, kind: 'bug', q: 'a' }),
    ).toBe(2);
  });

  test('the API query carries the filters and the cursor, trimmed', () => {
    expect(tasksQuery(EMPTY_TASK_FILTERS)).toBe('');
    expect(
      tasksQuery({ ...EMPTY_TASK_FILTERS, q: ' a b ', kind: 'bug' }, 'c1'),
    ).toBe('?kind=bug&q=a+b&cursor=c1');
  });
});

describe('statuses', () => {
  test('every status has a label and a pill status', () => {
    for (const status of TASK_STATUSES) {
      expect(TASK_STATUS_LABEL[status]).toBeTruthy();
      expect(TASK_PILL_STATUS[status]).toBeTruthy();
    }
  });

  test('a task that needs talk reads as blocked', () => {
    expect(TASK_PILL_STATUS.needs_talk).toBe('blocked');
  });
});

describe('rowStatus', () => {
  const issue = (liveStatus: 'queued' | null) => ({
    number: 1,
    url: 'https://example.test/1',
    liveStatus,
    prNumber: null,
    prUrl: null,
  });

  test('an issue with no live status yet reads Issued', () => {
    const waiting = {
      ...row('a'),
      status: 'approved' as const,
      issue: issue(null),
    };
    expect(rowStatus(waiting)).toBe('issued');
  });

  test('otherwise the row carries its own status', () => {
    expect(
      rowStatus({ ...row('a'), status: 'queued', issue: issue('queued') }),
    ).toBe('queued');
    expect(rowStatus(row('a'))).toBe('draft');
  });
});

describe('taskPlannerHref', () => {
  test('opens the task in its plan, escaping the ids', () => {
    expect(taskPlannerHref(row('x'))).toBe(
      '/projects/p%201/planner/plan1?task=t3',
    );
  });
});

describe('mergeTaskRows', () => {
  test('appends a page and drops rows already shown', () => {
    const merged = mergeTaskRows([row('a'), row('b')], [row('b'), row('c')]);
    expect(merged.map((r) => r.taskId)).toEqual(['a', 'b', 'c']);
  });
});

describe('describePlannerError', () => {
  test('a 404 does not say whether the plan exists', () => {
    const text = describePlannerError(new ApiError(404, undefined, 'x'));
    expect(text).toContain('no longer exists');
  });

  test('forbidden is a sentence, not the server text', () => {
    const error = new ApiError(
      403,
      PLANNER_ERROR.forbidden as never,
      'Forbidden resource',
    );
    expect(describePlannerError(error)).toBe(
      'You are not allowed to do that here.',
    );
  });

  test('anything else falls back to the server text, and a network error to a sentence', () => {
    expect(describePlannerError(new ApiError(500, undefined, 'boom'))).toBe(
      'boom',
    );
    expect(describePlannerError(new Error('x'))).toBe(
      'Could not reach the server.',
    );
  });
});
