import { describe, expect, it } from 'bun:test';
import type { WorkCardItem, WorkPlanTaskItem } from './contracts';
import { workItemStatus } from './contracts';
import {
  parseWorkSearch,
  planTaskBoardLabel,
  workCardHref,
  workPlanTaskHref,
} from './format';
import { PLAN_TASK_FACE_TITLE_MAX } from './types';

describe('planTaskBoardLabel (D6)', () => {
  it('joins the key and the plan title', () => {
    expect(planTaskBoardLabel('t3', 'Onboarding v2')).toBe(
      't3 · Onboarding v2',
    );
  });

  it(`keeps a title of exactly ${PLAN_TASK_FACE_TITLE_MAX} characters`, () => {
    const title = 'x'.repeat(PLAN_TASK_FACE_TITLE_MAX);
    expect(planTaskBoardLabel('t1', title)).toBe(`t1 · ${title}`);
  });

  it(`cuts a longer title to ${PLAN_TASK_FACE_TITLE_MAX} characters with an ellipsis`, () => {
    const label = planTaskBoardLabel(
      't1',
      'A very long plan title that keeps going',
    );
    const title = label.slice('t1 · '.length);
    expect(title.length).toBeLessThanOrEqual(PLAN_TASK_FACE_TITLE_MAX);
    expect(title.endsWith('…')).toBe(true);
    expect(title).toBe('A very long plan title…');
  });

  it('is the key alone when the plan has no title', () => {
    expect(planTaskBoardLabel('t1', '  ')).toBe('t1');
  });
});

describe('hrefs', () => {
  it('opens a card sheet on the board', () => {
    expect(workCardHref('p1', 12)).toBe('/projects/p1/board?card=12');
  });

  it('opens a plan-task sheet on the board (D7)', () => {
    expect(workPlanTaskHref('p1', 'plan 1', 't3')).toBe(
      '/projects/p1/board?plan=plan%201&task=t3',
    );
  });
});

describe('parseWorkSearch (D10)', () => {
  it('reads a card label in any case', () => {
    expect(parseWorkSearch(' C-12 ').cardNumber).toBe(12);
    expect(parseWorkSearch('c-7').cardNumber).toBe(7);
    expect(parseWorkSearch('C-0').cardNumber).toBeNull();
  });

  it('reads an issue number', () => {
    const search = parseWorkSearch('#41');
    expect(search).toEqual({
      text: '#41',
      cardNumber: null,
      issueNumber: 41,
      taskKey: null,
    });
  });

  it('reads something shaped like a task key, lower-cased', () => {
    expect(parseWorkSearch('T3').taskKey).toBe('t3');
    expect(parseWorkSearch('login flow').taskKey).toBeNull();
  });

  it('always keeps the trimmed text for the title match', () => {
    expect(parseWorkSearch('  Login flow ')).toEqual({
      text: 'Login flow',
      cardNumber: null,
      issueNumber: null,
      taskKey: null,
    });
  });
});

describe('workItemStatus (D10)', () => {
  const base = {
    projectId: 'p1',
    projectName: 'P',
    title: 'x',
    kind: 'bug' as const,
    updatedAt: '2026-10-15T00:00:00.000Z',
    href: '/x',
  };

  it('is the column of a card', () => {
    const card: WorkCardItem = {
      ...base,
      source: 'inbox',
      cardId: 'c1',
      number: 1,
      label: 'C-1',
      column: 'inbox',
      roundPhase: null,
      issueNumber: null,
      issueUrl: null,
      prNumber: null,
      prUrl: null,
    };
    expect(workItemStatus(card)).toBe('inbox');
  });

  it('is the work status of a plan task', () => {
    const task: WorkPlanTaskItem = {
      ...base,
      source: 'plan',
      planId: 'pl1',
      planTitle: 'Plan',
      taskId: 't',
      key: 't1',
      status: 'rejected',
      nativeStatus: 'rejected',
      issue: null,
    };
    expect(workItemStatus(task)).toBe('rejected');
  });
});
