import {
  BOARD_COLUMNS,
  type BoardColumn,
  type BoardPlanTasksView,
  type BoardPlanTaskView,
  type BoardView,
  planTaskBoardLabel,
} from '@agentdock/shared';
import { api } from '../api';
import { DESIGN_CHIP_LABEL } from '../design/format';
import {
  rowStatus,
  TASK_PILL_STATUS,
  TASK_STATUS_LABEL,
} from '../tasks/format';
import { type BoardItem, columnsOf, toItem } from './format';

/** `GET /projects/:projectId/work/plan-tasks` (#270 D8). */
export const fetchPlanTasks = (projectId: string) =>
  api<BoardPlanTasksView>(`/projects/${projectId}/work/plan-tasks`);

/** The id prefix that keeps a plan task apart from a card id in glass-ui's `Board`. */
const PLAN_ITEM_PREFIX = 'plan:';

/** One plan task as glass-ui's `Board` takes it: read-only (D5). */
export interface PlanItem {
  id: string;
  label: string;
  /** Always `false`: the plan decides the column (ADR-0028), so no drag and no move entries. */
  movable: false;
  planTask: BoardPlanTaskView;
}

/** Everything a board column can hold. */
export type WorkBoardItem = BoardItem | PlanItem;

export const isPlanItem = (item: WorkBoardItem): item is PlanItem =>
  'planTask' in item;

export const isPlanTaskItemId = (id: string): boolean =>
  id.startsWith(PLAN_ITEM_PREFIX);

export const toPlanItem = (planTask: BoardPlanTaskView): PlanItem => ({
  id: `${PLAN_ITEM_PREFIX}${planTask.taskId}`,
  label: `${planTaskBoardLabel(planTask.key, planTask.planTitle)} ${planTask.title}`,
  movable: false,
  planTask,
});

/** D4: newest `updatedAt` first; the id breaks a tie so the order is stable. */
const newestFirst = (a: BoardPlanTaskView, b: BoardPlanTaskView): number =>
  a.updatedAt < b.updatedAt
    ? 1
    : a.updatedAt > b.updatedAt
      ? -1
      : a.taskId.localeCompare(b.taskId);

/**
 * D2–D4: the items of every column — the cards in their position order, then
 * the plan tasks of that column, newest first. A plan task never enters the
 * Inbox, whatever the payload says.
 */
export function boardItems(
  view: BoardView,
  planTasks: readonly BoardPlanTaskView[],
): Map<BoardColumn, WorkBoardItem[]> {
  const items = new Map<BoardColumn, WorkBoardItem[]>();
  for (const column of columnsOf(view)) {
    items.set(column.column, column.cards.map(toItem));
  }
  const sorted = [...planTasks].sort(newestFirst);
  for (const column of BOARD_COLUMNS) {
    if (column === 'inbox') continue;
    const bucket = items.get(column);
    if (!bucket) continue;
    for (const task of sorted) {
      if (task.column === column) bucket.push(toPlanItem(task));
    }
  }
  return items;
}

/** The plan task a `?plan=<planId>&task=<key>` URL names; `undefined` for a half or empty pair. */
export function parsePlanTaskParam(
  plan: string | null,
  task: string | null,
): { planId: string; key: string } | undefined {
  if (!plan || !task) return undefined;
  return { planId: plan, key: task };
}

export const findPlanTask = (
  planTasks: readonly BoardPlanTaskView[],
  planId: string,
  key: string,
): BoardPlanTaskView | undefined =>
  planTasks.find((t) => t.planId === planId && t.key === key);

/** The design chip of a plan task (as the Planner's), or `null` while it has none. */
export function planTaskDesignChip(
  task: BoardPlanTaskView,
): { label: string; approved: boolean } | null {
  const design = task.design;
  if (!design) return null;
  if (design.status === 'approved') {
    return { label: DESIGN_CHIP_LABEL.approved, approved: true };
  }
  if (design.needed) return { label: DESIGN_CHIP_LABEL.on, approved: false };
  return design.suggested
    ? { label: DESIGN_CHIP_LABEL.suggested, approved: false }
    : null;
}

/** The task's status pill, in the vocabulary of the Planner and the Tasks page. */
export function planTaskPill(task: BoardPlanTaskView) {
  const status = rowStatus({ status: task.status, issue: task.issue });
  return { status: TASK_PILL_STATUS[status], label: TASK_STATUS_LABEL[status] };
}
