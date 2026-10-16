import { BOARD_COLUMNS } from '../board/types';

/**
 * One Work surface (issue #270, ADR-0028): board cards and plan tasks seen
 * together — plan tasks projected read-only onto the project Board, and one
 * List across projects. The data models stay separate (ADR-0024, ADR-0025).
 */

/** D10: where a List row comes from. `inbox` is a captured suggestion (#244); `fleet` a mirrored fleet slot (#388). */
export const WORK_SOURCES = ['card', 'plan', 'inbox', 'fleet'] as const;
export type WorkSource = (typeof WORK_SOURCES)[number];

export const isWorkSource = (value: string): value is WorkSource =>
  (WORK_SOURCES as readonly string[]).includes(value);

/**
 * D10: one status vocabulary for every source — the board column, plus
 * `rejected`, which only a plan task can be (it is off the board, D2).
 */
export const WORK_STATUSES = [...BOARD_COLUMNS, 'rejected'] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

export const isWorkStatus = (value: string): value is WorkStatus =>
  (WORK_STATUSES as readonly string[]).includes(value);

/** D10: `GET /work` pages. */
export const WORK_PAGE_SIZE = 50;

/** D10: `q` of `GET /work`. */
export const WORK_QUERY_TEXT_MAX = 200;

/** D6: the plan title on a plan task's board face is cut to this many characters. */
export const PLAN_TASK_FACE_TITLE_MAX = 24;
