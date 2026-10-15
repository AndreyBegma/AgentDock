import type { BoardColumn } from '../board/types';
import {
  PLAN_TASK_LIVE_STATUSES,
  type PlanStatus,
  type PlanTaskLiveStatus,
  type PlanTaskStatus,
} from '../planner/types';
import type { WorkStatus } from './types';

/**
 * D2: the board column of a plan task — a fact about the plan and GitHub,
 * never a person's move (D5). `null`: not on the board (`rejected`). A plan
 * task never enters the Inbox. Pure.
 */
export const planTaskBoardColumn = (
  status: PlanTaskStatus,
  live: PlanTaskLiveStatus | null,
): BoardColumn | null => {
  if (status === 'rejected') return null;
  if (status !== 'issued') return 'todo';
  // Issued but not queued yet (a feature waiting for its docs PR) counts as
  // In progress: the owner's "issued / in the fleet".
  if (live === 'pr_open') return 'finished';
  if (live === 'merged' || live === 'closed') return 'completed';
  return 'in_progress';
};

/** D10: a plan task's List status — its column, or `rejected`. */
export const workStatusOfPlanTask = (
  status: PlanTaskStatus,
  live: PlanTaskLiveStatus | null,
): WorkStatus => planTaskBoardColumn(status, live) ?? 'rejected';

const isLiveStatus = (
  status: PlanTaskStatus | PlanTaskLiveStatus,
): status is PlanTaskLiveStatus =>
  (PLAN_TASK_LIVE_STATUSES as readonly string[]).includes(status);

/**
 * D10, D13: the List status of a combined task status — the live status once
 * issued, the task's own status before (`TaskRow.status`,
 * `BoardPlanTaskView.status`, the old `/tasks?status=`).
 */
export const workStatusOfTaskStatus = (
  status: PlanTaskStatus | PlanTaskLiveStatus,
): WorkStatus =>
  isLiveStatus(status)
    ? workStatusOfPlanTask('issued', status)
    : workStatusOfPlanTask(status, null);

/**
 * D2, D3: the column of a plan task on the board, given its plan. A task of
 * an `archived` plan is on the board only once issued — the fleet may still
 * be working on it; an unissued one is not. A `done` plan's tasks became
 * board cards (#337 D7): the cards stand for them, so they leave too.
 */
export const boardColumnOfPlanTask = (task: {
  planStatus: PlanStatus;
  status: PlanTaskStatus;
  liveStatus: PlanTaskLiveStatus | null;
}): BoardColumn | null =>
  (task.planStatus === 'archived' || task.planStatus === 'done') &&
  task.status !== 'issued'
    ? null
    : planTaskBoardColumn(task.status, task.liveStatus);
