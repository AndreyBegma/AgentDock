import { describe, expect, test } from 'bun:test';
import type { WorkItem } from '@agentdock/shared';
import {
  EMPTY_WORK_FILTERS,
  filtersFromSearch,
  filtersSearch,
  hasWorkFilters,
  mergeWorkItems,
  tasksRedirectTarget,
  WORK_FILTER_CODEC,
  workChipDefs,
  workQuery,
} from './format';

const FULL = {
  projectId: 'p1',
  source: 'plan',
  kind: 'bug',
  status: 'in_progress',
  planId: 'plan1',
  q: 'login',
} as const;

describe('work filter codec', () => {
  test('round-trips every filter through the URL', () => {
    const search = filtersSearch({ ...FULL });
    expect(filtersFromSearch(new URLSearchParams(search))).toEqual(FULL);
    expect(WORK_FILTER_CODEC.parse(new URLSearchParams(search))).toEqual(FULL);
  });

  test('drops unknown source, kind and status', () => {
    const parsed = filtersFromSearch(
      new URLSearchParams('source=evil&kind=chore&status=merged&q=x'),
    );
    expect(parsed).toEqual({ ...EMPTY_WORK_FILTERS, q: 'x' });
  });

  test('empty filters make an empty search', () => {
    expect(filtersSearch(EMPTY_WORK_FILTERS)).toBe('');
    expect(hasWorkFilters(EMPTY_WORK_FILTERS)).toBe(false);
    expect(hasWorkFilters({ ...EMPTY_WORK_FILTERS, source: 'inbox' })).toBe(
      true,
    );
  });

  test('chips name the filters in force, the plan as "One plan"', () => {
    const defs = workChipDefs(() => 'Alpha');
    const labels = defs.map((d) => d.label({ ...FULL }));
    expect(labels).toContain('Project: Alpha');
    expect(labels).toContain('Source: Plan');
    expect(labels).toContain('Status: In progress');
    expect(labels).toContain('One plan');
  });
});

describe('workQuery', () => {
  test('carries filters and cursor, trims q', () => {
    const query = new URLSearchParams(
      workQuery({ ...FULL, q: ' login ' }, 'c1'),
    );
    expect(query.get('source')).toBe('plan');
    expect(query.get('status')).toBe('in_progress');
    expect(query.get('q')).toBe('login');
    expect(query.get('cursor')).toBe('c1');
  });

  test('nothing set is empty', () => {
    expect(workQuery(EMPTY_WORK_FILTERS)).toBe('');
  });
});

describe('tasksRedirectTarget (D13)', () => {
  test('always filters to plan tasks', () => {
    expect(tasksRedirectTarget({})).toBe('/work?source=plan');
  });

  test('carries projectId, kind, q and planId', () => {
    const target = new URL(
      tasksRedirectTarget({
        projectId: 'p1',
        kind: 'bug',
        q: 'x y',
        planId: 'pl',
      }),
      'http://x',
    );
    expect(target.pathname).toBe('/work');
    expect(target.searchParams.get('source')).toBe('plan');
    expect(target.searchParams.get('projectId')).toBe('p1');
    expect(target.searchParams.get('kind')).toBe('bug');
    expect(target.searchParams.get('q')).toBe('x y');
    expect(target.searchParams.get('planId')).toBe('pl');
  });

  test('maps each old status through D2', () => {
    const status = (s: string) =>
      new URL(tasksRedirectTarget({ status: s }), 'http://x').searchParams.get(
        'status',
      );
    for (const s of [
      'draft',
      'needs_talk',
      'needs_design',
      'ready',
      'approved',
      'rewrite_requested',
    ]) {
      expect(status(s)).toBe('todo');
    }
    expect(status('issued')).toBe('in_progress');
    expect(status('queued')).toBe('in_progress');
    expect(status('in_flight')).toBe('in_progress');
    expect(status('pr_open')).toBe('finished');
    expect(status('merged')).toBe('completed');
    expect(status('closed')).toBe('completed');
    expect(status('rejected')).toBe('rejected');
  });

  test('drops an unknown status or kind', () => {
    expect(tasksRedirectTarget({ status: 'bogus', kind: 'chore' })).toBe(
      '/work?source=plan',
    );
  });
});

describe('mergeWorkItems', () => {
  const base = {
    projectId: 'p',
    projectName: 'P',
    title: 't',
    kind: 'bug' as const,
    updatedAt: '2026-10-15T00:00:00Z',
    href: '/x',
  };
  const card = (cardId: string): WorkItem => ({
    ...base,
    source: 'card',
    cardId,
    number: 1,
    label: 'C-1',
    column: 'todo',
    roundPhase: null,
    issueNumber: null,
    issueUrl: null,
    prNumber: null,
    prUrl: null,
  });
  const plan = (taskId: string): WorkItem => ({
    ...base,
    source: 'plan',
    planId: 'pl',
    planTitle: 'Plan',
    taskId,
    key: 't1',
    status: 'todo',
    nativeStatus: 'draft',
    issue: null,
  });

  test('a refetched row is not doubled; a card and a task with one id are both kept', () => {
    const merged = mergeWorkItems(
      [card('a'), plan('a')],
      [card('a'), card('b')],
    );
    expect(
      merged.map((i) => (i.source === 'plan' ? i.taskId : i.cardId)),
    ).toEqual(['a', 'a', 'b']);
  });
});
