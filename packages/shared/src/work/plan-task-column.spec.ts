import { describe, expect, it } from 'bun:test';
import type { BoardColumn } from '../board/types';
import {
  PLAN_STATUSES,
  PLAN_TASK_LIVE_STATUSES,
  PLAN_TASK_STATUSES,
  type PlanTaskLiveStatus,
  type PlanTaskStatus,
} from '../planner/types';
import {
  boardColumnOfPlanTask,
  planTaskBoardColumn,
  workStatusOfPlanTask,
  workStatusOfTaskStatus,
} from './plan-task-column';

const LIVE = [null, ...PLAN_TASK_LIVE_STATUSES] as const;

/** D2, written out once by hand. */
const ISSUED: Record<PlanTaskLiveStatus | 'null', BoardColumn> = {
  null: 'in_progress',
  queued: 'in_progress',
  in_flight: 'in_progress',
  pr_open: 'finished',
  merged: 'completed',
  closed: 'completed',
};

const BEFORE_ISSUE: Record<
  Exclude<PlanTaskStatus, 'issued'>,
  BoardColumn | null
> = {
  draft: 'todo',
  needs_talk: 'todo',
  needs_design: 'todo',
  ready: 'todo',
  approved: 'todo',
  rewrite_requested: 'todo',
  rejected: null,
};

describe('planTaskBoardColumn (D2)', () => {
  for (const status of PLAN_TASK_STATUSES) {
    for (const live of LIVE) {
      const expected =
        status === 'issued' ? ISSUED[live ?? 'null'] : BEFORE_ISSUE[status];
      it(`${status} + ${live ?? 'null'} → ${expected ?? 'off the board'}`, () => {
        expect(planTaskBoardColumn(status, live)).toBe(expected);
      });
    }
  }

  it('never puts a plan task in the Inbox', () => {
    for (const status of PLAN_TASK_STATUSES) {
      for (const live of LIVE) {
        expect(planTaskBoardColumn(status, live)).not.toBe('inbox');
      }
    }
  });
});

describe('workStatusOfPlanTask (D10)', () => {
  it('is the column, or rejected', () => {
    for (const status of PLAN_TASK_STATUSES) {
      for (const live of LIVE) {
        expect(workStatusOfPlanTask(status, live)).toBe(
          planTaskBoardColumn(status, live) ?? 'rejected',
        );
      }
    }
  });
});

describe('workStatusOfTaskStatus (D13)', () => {
  it('maps a live status as an issued task with that live status', () => {
    for (const live of PLAN_TASK_LIVE_STATUSES) {
      expect(workStatusOfTaskStatus(live)).toBe(ISSUED[live]);
    }
  });

  it('maps a task status as a task with no live status', () => {
    expect(workStatusOfTaskStatus('issued')).toBe('in_progress');
    expect(workStatusOfTaskStatus('rejected')).toBe('rejected');
    for (const status of PLAN_TASK_STATUSES) {
      if (status === 'issued' || status === 'rejected') continue;
      expect(workStatusOfTaskStatus(status)).toBe('todo');
    }
  });
});

describe('boardColumnOfPlanTask (D3)', () => {
  it('keeps only issued tasks of an archived plan', () => {
    for (const status of PLAN_TASK_STATUSES) {
      for (const liveStatus of LIVE) {
        expect(
          boardColumnOfPlanTask({ planStatus: 'archived', status, liveStatus }),
        ).toBe(
          status === 'issued' ? planTaskBoardColumn(status, liveStatus) : null,
        );
      }
    }
  });

  it('drops the tasks of a done plan: they became cards (#337 D7)', () => {
    for (const status of PLAN_TASK_STATUSES) {
      if (status === 'issued') continue;
      for (const liveStatus of LIVE) {
        expect(
          boardColumnOfPlanTask({ planStatus: 'done', status, liveStatus }),
        ).toBeNull();
      }
    }
  });

  it('is planTaskBoardColumn for every other plan status', () => {
    for (const planStatus of PLAN_STATUSES) {
      if (planStatus === 'archived' || planStatus === 'done') continue;
      for (const status of PLAN_TASK_STATUSES) {
        for (const liveStatus of LIVE) {
          expect(
            boardColumnOfPlanTask({ planStatus, status, liveStatus }),
          ).toBe(planTaskBoardColumn(status, liveStatus));
        }
      }
    }
  });
});
