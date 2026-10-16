import type { CardFleetView } from '../board/contracts';
import type {
  BoardCardKind,
  BoardColumn,
  CardRoundPhase,
} from '../board/types';
import type { TaskDesignSummary } from '../design';
import type { PlanTaskIssueView } from '../planner/contracts';
import type {
  PlanTaskKind,
  PlanTaskLiveStatus,
  PlanTaskStatus,
} from '../planner/types';
import type { WorkSource, WorkStatus } from './types';

/**
 * HTTP contracts of the Work surface (issue #270 "API"): two read routes in
 * the `work` module. Neither writes; a plan task changes only in the Planner.
 */

// Board

/**
 * D6: one plan task projected onto the project Board — read-only, in the
 * column D2 derives, after the cards of that column (D4).
 */
export interface BoardPlanTaskView {
  planId: string;
  planTitle: string;
  taskId: string;
  key: string;
  title: string;
  kind: PlanTaskKind;
  /** D2; never `inbox`. */
  column: BoardColumn;
  /** The live status once issued, the task's own status before (as `TaskRow`). */
  status: PlanTaskStatus | PlanTaskLiveStatus;
  issue: PlanTaskIssueView | null;
  /** The design chip; `null` while the task has no design. */
  design: TaskDesignSummary | null;
  /** Markdown, for the plan-task sheet (D7). */
  summary: string;
  updatedAt: string;
}

/**
 * `GET /projects/:projectId/work/plan-tasks` (D8): the current-version tasks
 * of the plans the caller may read, newest `updatedAt` first — the web groups
 * them by `column` after the cards. Completed holds at most
 * `BOARD_COMPLETED_PAGE_SIZE` (D3).
 */
export interface BoardPlanTasksView {
  projectId: string;
  items: BoardPlanTaskView[];
}

// List

/** `GET /work` query (D10). Every filter is optional; `status` is the column vocabulary for every source. */
export interface WorkQuery {
  projectId?: string;
  source?: WorkSource;
  kind?: BoardCardKind;
  status?: WorkStatus;
  /** Title (case-insensitive), a card label `C-12`, a task key, or an issue `#12`. */
  q?: string;
  planId?: string;
  cursor?: string;
}

interface WorkItemBase {
  projectId: string;
  projectName: string;
  title: string;
  kind: BoardCardKind;
  updatedAt: string;
  /** Where the row opens in the web (`workCardHref` / `workPlanTaskHref`). */
  href: string;
}

/**
 * A board card (`card`) or an Inbox suggestion (`inbox`, operators only —
 * D11). Its status pill is `column`; `roundPhase` is the native detail.
 */
export interface WorkCardItem extends WorkItemBase {
  source: 'card' | 'inbox' | 'fleet';
  /** #388: a `fleet` row's slot, stage and issue; absent on every other source. */
  fleet?: CardFleetView;
  cardId: string;
  number: number;
  /** `C-<number>`. */
  label: string;
  column: BoardColumn;
  /** The latest round's phase; `null` before the first Run. */
  roundPhase: CardRoundPhase | null;
  issueNumber: number | null;
  issueUrl: string | null;
  prNumber: number | null;
  prUrl: string | null;
}

/** A task of the current version of a readable plan. */
export interface WorkPlanTaskItem extends WorkItemBase {
  source: 'plan';
  planId: string;
  planTitle: string;
  taskId: string;
  key: string;
  /** D10: the column, or `rejected`. */
  status: WorkStatus;
  /** The pill's detail: the live status once issued, the task's own status before. */
  nativeStatus: PlanTaskStatus | PlanTaskLiveStatus;
  issue: PlanTaskIssueView | null;
}

export type WorkItem = WorkCardItem | WorkPlanTaskItem;

/** `GET /work`: keyset `(updatedAt, id)` descending, `WORK_PAGE_SIZE` a page. */
export interface WorkPage {
  items: WorkItem[];
  nextCursor: string | null;
}

/** D10: one status vocabulary for every row. */
export const workItemStatus = (item: WorkItem): WorkStatus =>
  item.source === 'plan' ? item.status : item.column;

/** `GET /work` errors. */
export const WORK_ERROR = {
  /** 400: an unknown cursor. */
  invalidArgs: 'invalid_args',
} as const;
export type WorkErrorCode = (typeof WORK_ERROR)[keyof typeof WORK_ERROR];

/** D5: the `plan_task_derived` refusal of `boardMoveRule`, as the web shows it. */
export const PLAN_TASK_MOVE_REFUSAL_TEXT =
  'A plan task moves with its plan and its issue — open it in the Planner.';
