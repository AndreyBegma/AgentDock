import { describe, expect, test } from 'bun:test';
import {
  type BoardColumn,
  type BoardPlanTaskView,
  PLAN_TASK_MOVE_REFUSAL_TEXT,
} from '@agentdock/shared';
import { resolveBoardMove } from '@andrewbehma/glass-ui/board';
import { decideDrop } from './board-state';
import { boardView, card } from './fixtures';
import { columnsOf } from './format';
import {
  boardItems,
  findPlanTask,
  isPlanItem,
  parsePlanTaskParam,
  planTaskDesignChip,
  planTaskPill,
  toPlanItem,
} from './plan-tasks';

export const planTask = (
  key: string,
  column: Exclude<BoardColumn, 'inbox'>,
  extra: Partial<BoardPlanTaskView> = {},
): BoardPlanTaskView => ({
  planId: 'plan-1',
  planTitle: 'Onboarding v2',
  taskId: `task-${key}`,
  key,
  title: `Task ${key}`,
  kind: 'feature',
  column,
  status: 'draft',
  issue: null,
  design: null,
  summary: '',
  updatedAt: '2026-10-14T10:00:00.000Z',
  ...extra,
});

const ids = (items: ReturnType<typeof boardItems>, column: BoardColumn) =>
  (items.get(column) ?? []).map((i) => i.id);

describe('boardItems (D4)', () => {
  test('puts plan tasks after the cards of their column', () => {
    const view = boardView([card(1, 'todo'), card(2, 'todo')]);
    const items = boardItems(view, [planTask('t1', 'todo')]);
    expect(ids(items, 'todo')).toEqual(['card-1', 'card-2', 'plan:task-t1']);
  });

  test('orders plan tasks newest updatedAt first', () => {
    const items = boardItems(boardView([]), [
      planTask('t1', 'todo', { updatedAt: '2026-10-10T00:00:00.000Z' }),
      planTask('t2', 'todo', { updatedAt: '2026-10-14T00:00:00.000Z' }),
      planTask('t3', 'todo', { updatedAt: '2026-10-12T00:00:00.000Z' }),
    ]);
    expect(ids(items, 'todo')).toEqual([
      'plan:task-t2',
      'plan:task-t3',
      'plan:task-t1',
    ]);
  });

  test('puts each plan task in the column the server derived', () => {
    const items = boardItems(boardView([card(1, 'finished')]), [
      planTask('a', 'in_progress'),
      planTask('b', 'finished'),
      planTask('c', 'completed'),
    ]);
    expect(ids(items, 'in_progress')).toEqual(['plan:task-a']);
    expect(ids(items, 'finished')).toEqual(['card-1', 'plan:task-b']);
    expect(ids(items, 'completed')).toEqual(['plan:task-c']);
  });

  test('never puts a plan task in the Inbox', () => {
    const bad = { ...planTask('x', 'todo'), column: 'inbox' } as never;
    const items = boardItems(boardView([]), [bad]);
    expect(ids(items, 'inbox')).toEqual([]);
  });

  test('marks plan items apart from cards', () => {
    const items = boardItems(boardView([card(1, 'todo')]), [
      planTask('t1', 'todo'),
    ]);
    const [first, second] = items.get('todo') ?? [];
    expect(first && isPlanItem(first)).toBe(false);
    expect(second && isPlanItem(second)).toBe(true);
  });
});

describe('decideDrop of a plan task (D5)', () => {
  const drop = {
    id: toPlanItem(planTask('t1', 'todo')).id,
    fromColumnId: 'todo',
    toColumnId: 'in_progress',
    index: 0,
  };

  test('is refused with the plan_task_derived text', () => {
    const decision = decideDrop(boardView([card(1, 'todo')]), drop);
    expect(decision).toEqual({
      kind: 'refused',
      error: 'plan_task_derived',
      text: PLAN_TASK_MOVE_REFUSAL_TEXT,
    });
  });

  test('is refused inside its own column too (no reorder)', () => {
    const decision = decideDrop(boardView([]), {
      ...drop,
      toColumnId: 'todo',
      index: 1,
    });
    expect(decision.kind).toBe('refused');
  });

  test('leaves a card drop unchanged', () => {
    const decision = decideDrop(boardView([card(1, 'todo')]), {
      id: 'card-1',
      fromColumnId: 'todo',
      toColumnId: 'finished',
      index: 0,
    });
    expect(decision.kind).toBe('move');
  });
});

describe('a plan task is not movable (C-44)', () => {
  const view = boardView([card(1, 'todo')]);
  const items = boardItems(view, [planTask('t1', 'todo')]);
  const columns = columnsOf(view).map((c) => ({
    id: c.column,
    title: c.column,
    cards: items.get(c.column) ?? [],
  }));
  const planId = toPlanItem(planTask('t1', 'todo')).id;

  test('its item says movable: false; a card item leaves the default', () => {
    const [cardItem, planItem] = items.get('todo') ?? [];
    expect(planItem && isPlanItem(planItem) && planItem.movable).toBe(false);
    expect(cardItem && 'movable' in cardItem).toBe(false);
  });

  test("glass-ui's reducer refuses a drag and a menu move for it", () => {
    expect(
      resolveBoardMove(columns, {
        kind: 'drop',
        id: planId,
        columnId: 'in_progress',
        index: 0,
      }),
    ).toBeNull();
    for (const command of ['up', 'top', { toColumnId: 'finished' }] as const) {
      expect(
        resolveBoardMove(columns, { kind: 'command', id: planId, command }),
      ).toBeNull();
    }
  });

  test('a card still moves, from either input', () => {
    expect(
      resolveBoardMove(columns, {
        kind: 'command',
        id: 'card-1',
        command: { toColumnId: 'finished' },
      }),
    ).toEqual({
      id: 'card-1',
      fromColumnId: 'todo',
      toColumnId: 'finished',
      index: 0,
    });
    expect(
      resolveBoardMove(columns, {
        kind: 'drop',
        id: 'card-1',
        columnId: 'in_progress',
        index: 0,
      }),
    ).not.toBeNull();
  });
});

describe('helpers', () => {
  test('parsePlanTaskParam needs both halves', () => {
    expect(parsePlanTaskParam('p', 't3')).toEqual({ planId: 'p', key: 't3' });
    expect(parsePlanTaskParam('p', null)).toBeUndefined();
    expect(parsePlanTaskParam(null, 't3')).toBeUndefined();
    expect(parsePlanTaskParam('', 't3')).toBeUndefined();
  });

  test('findPlanTask matches the plan and the key', () => {
    const tasks = [
      planTask('t1', 'todo'),
      planTask('t1', 'todo', { planId: 'plan-2', taskId: 'other' }),
    ];
    expect(findPlanTask(tasks, 'plan-2', 't1')?.taskId).toBe('other');
    expect(findPlanTask(tasks, 'plan-3', 't1')).toBeUndefined();
  });

  test('an issued task without a live status reads Issued', () => {
    const pill = planTaskPill(
      planTask('t1', 'in_progress', {
        status: 'issued',
        issue: {
          number: 7,
          url: 'https://github.com/o/r/issues/7',
          liveStatus: null,
          prNumber: null,
          prUrl: null,
        },
      }),
    );
    expect(pill.label).toBe('Issued');
  });

  test('the design chip follows the Planner: off, suggested, on, approved', () => {
    const design = (patch: object) =>
      planTask('t1', 'todo', {
        design: {
          needed: false,
          suggested: false,
          suggestionWhy: null,
          variantCount: 0,
          status: 'idle',
          approvedRevisionId: null,
          busySince: null,
          ...patch,
        } as never,
      });
    expect(planTaskDesignChip(planTask('t1', 'todo'))).toBeNull();
    expect(planTaskDesignChip(design({}))).toBeNull();
    expect(planTaskDesignChip(design({ suggested: true }))?.label).toBe(
      'Design suggested',
    );
    expect(planTaskDesignChip(design({ needed: true }))?.label).toBe(
      'Design on',
    );
    expect(planTaskDesignChip(design({ status: 'approved' }))).toEqual({
      label: 'Design approved',
      approved: true,
    });
  });
});
