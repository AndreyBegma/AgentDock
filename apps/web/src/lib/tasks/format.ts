import type { Status } from '@andrewbehma/glass-ui/status-pill';
import {
  PLAN_TASK_KINDS,
  PLAN_TASK_LIVE_STATUSES,
  PLAN_TASK_STATUSES,
  PLANNER_ERROR,
  type PlannerSpecOutput,
  type PlanTaskKind,
  type PlanTaskLiveStatus,
  type PlanTaskStatus,
  type TaskRow,
  type TasksQuery,
} from '@nautelle/shared';
import { ApiError } from '../api';
import type { ChipDef, FilterCodec } from '../filters/url-filters';

/** A task's status before its issue, or its live status after (spec 172 "Data / Schema"). */
export type TaskStatus = PlanTaskStatus | PlanTaskLiveStatus;

/** The order the status filter lists them in: the draft's life, then the issue's. */
export const TASK_STATUSES: readonly TaskStatus[] = [
  ...PLAN_TASK_STATUSES,
  ...PLAN_TASK_LIVE_STATUSES,
];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  draft: 'Draft',
  needs_talk: 'Needs talk',
  needs_design: 'Needs design',
  ready: 'Ready',
  approved: 'Approved',
  rejected: 'Rejected',
  rewrite_requested: 'Rewrite requested',
  issued: 'Issued',
  queued: 'Queued',
  in_flight: 'In flight',
  pr_open: 'PR open',
  merged: 'Merged',
  closed: 'Closed',
};

/** The shared status scale, so a task reads like a slot or a run in the same state. */
export const TASK_PILL_STATUS: Record<TaskStatus, Status> = {
  draft: 'idle',
  needs_talk: 'blocked',
  needs_design: 'waiting',
  ready: 'waiting',
  approved: 'done',
  rejected: 'idle',
  rewrite_requested: 'paused',
  issued: 'waiting',
  queued: 'waiting',
  in_flight: 'running',
  pr_open: 'waiting',
  merged: 'done',
  closed: 'idle',
};

export const TASK_KIND_LABEL: Record<PlanTaskKind, string> = {
  bug: 'Bug',
  feature: 'Feature',
};

/**
 * What to show for a row. An issue that exists but is not queued yet (a
 * feature waiting for its docs pull request) has no live status: it reads
 * "Issued" (i172-api makes `liveStatus` nullable).
 */
export function rowStatus(
  row: Pick<TaskRow, 'status'> & {
    issue: { liveStatus: PlanTaskLiveStatus | null } | null;
  },
): TaskStatus {
  if (row.issue && row.issue.liveStatus === null) return 'issued';
  return row.status;
}

/** D10: how a feature's specification is published. */
export const SPEC_OUTPUT_LABEL: Record<PlannerSpecOutput, string> = {
  docs_pr: 'Docs pull request',
  issue_body: 'Issue body',
};

export const SPEC_OUTPUT_HINT: Record<PlannerSpecOutput, string> = {
  docs_pr:
    'One docs pull request carries every feature specification into the Spec folder — in this repository, or in the docs repository when the docs live there. Feature issues are queued once it merges; bugs are queued at once. Needs the Spec folder in Settings › Docs source (and a local clone of a remote docs repository).',
  issue_body:
    'The issue body is the whole specification, and every issue is queued at once.',
};

/** The filters of `/tasks`, all kept in the URL (spec 172 acceptance criteria). */
export interface TaskFilters {
  projectId: string;
  kind: PlanTaskKind | '';
  status: TaskStatus | '';
  planId: string;
  q: string;
}

export const EMPTY_TASK_FILTERS: TaskFilters = {
  projectId: '',
  kind: '',
  status: '',
  planId: '',
  q: '',
};

const FIELD_MAX = 200;

const isKind = (value: string): value is PlanTaskKind =>
  (PLAN_TASK_KINDS as readonly string[]).includes(value);

const isStatus = (value: string): value is TaskStatus =>
  (TASK_STATUSES as readonly string[]).includes(value);

/** Filters from a URL's search; an unknown kind or status is dropped, not trusted. */
export function filtersFromSearch(params: URLSearchParams): TaskFilters {
  const read = (key: string): string => {
    const value = params.get(key)?.trim() ?? '';
    return value.length > FIELD_MAX ? '' : value;
  };
  const kind = read('kind');
  const status = read('status');
  return {
    projectId: read('projectId'),
    kind: isKind(kind) ? kind : '',
    status: isStatus(status) ? status : '',
    planId: read('planId'),
    q: read('q'),
  };
}

const FILTER_KEYS = ['projectId', 'kind', 'status', 'planId', 'q'] as const;

/** `''` or `?…`, in a stable key order, empty fields left out. */
export function filtersSearch(filters: TaskFilters): string {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = filters[key].trim();
    if (value) params.set(key, value);
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export const hasTaskFilters = (filters: TaskFilters): boolean =>
  FILTER_KEYS.some((key) => filters[key].trim() !== '');

/** How many filters are set: the count on the phone's Filters trigger. */
export const taskFilterCount = (filters: TaskFilters): number =>
  FILTER_KEYS.filter((key) => filters[key].trim() !== '').length;

/** `/tasks`'s filters in the URL (`useUrlFilters`). */
export const TASK_FILTER_CODEC: FilterCodec<TaskFilters> = {
  keys: FILTER_KEYS,
  parse: filtersFromSearch,
  search: filtersSearch,
};

/**
 * The filters as removable chips. The plan has no select — it comes in on a
 * link from a plan — so its chip is the only place it shows.
 */
export const taskChipDefs = (
  projectName: (id: string) => string,
): ChipDef<TaskFilters>[] => [
  {
    key: 'q',
    label: (f) => (f.q.trim() ? `Search: ${f.q.trim()}` : null),
    clear: { q: '' },
  },
  {
    key: 'projectId',
    label: (f) => (f.projectId ? `Project: ${projectName(f.projectId)}` : null),
    clear: { projectId: '' },
  },
  {
    key: 'status',
    label: (f) => (f.status ? `Status: ${TASK_STATUS_LABEL[f.status]}` : null),
    clear: { status: '' },
  },
  {
    key: 'kind',
    label: (f) => (f.kind ? `Kind: ${TASK_KIND_LABEL[f.kind]}` : null),
    clear: { kind: '' },
  },
  {
    key: 'planId',
    label: (f) => (f.planId ? 'One plan' : null),
    clear: { planId: '' },
  },
];

/**
 * Whose Planner the empty list points to: the filtered project, else the
 * only one; null when there is no single project to name.
 */
export function plannerTarget(
  filters: Pick<TaskFilters, 'projectId'>,
  projectIds: readonly string[],
): string | null {
  if (filters.projectId) return filters.projectId;
  return projectIds.length === 1 ? projectIds[0] : null;
}

/** The `GET /tasks` query for the filters and a page cursor. */
export function tasksQuery(filters: TaskFilters, cursor?: string): string {
  const query: TasksQuery = {};
  if (filters.projectId) query.projectId = filters.projectId;
  if (filters.kind) query.kind = filters.kind;
  if (filters.status) query.status = filters.status;
  if (filters.planId) query.planId = filters.planId;
  if (filters.q.trim()) query.q = filters.q.trim();
  if (cursor) query.cursor = cursor;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) params.set(key, value);
  const text = params.toString();
  return text ? `?${text}` : '';
}

/**
 * The task in its plan: the planner page reads `planId` from the path and
 * `task` from the query (i172-web-planner's route).
 */
export const taskPlannerHref = (
  row: Pick<TaskRow, 'projectId' | 'planId' | 'key'>,
): string =>
  `/projects/${encodeURIComponent(row.projectId)}/planner/${encodeURIComponent(row.planId)}?task=${encodeURIComponent(row.key)}`;

/** Pages loaded one after another merge by task id, so a refetch never doubles a row. */
export function mergeTaskRows(
  current: readonly TaskRow[],
  next: readonly TaskRow[],
): TaskRow[] {
  const seen = new Set(current.map((row) => row.taskId));
  return [...current, ...next.filter((row) => !seen.has(row.taskId))];
}

const errorCode = (error: unknown): string | undefined =>
  error instanceof ApiError ? (error.code as string | undefined) : undefined;

/** Every planner error as a sentence for the person; the server's text last. */
export function describePlannerError(error: unknown): string {
  switch (errorCode(error)) {
    case PLANNER_ERROR.forbidden:
      return 'You are not allowed to do that here.';
    case PLANNER_ERROR.invalidArgs:
      return error instanceof ApiError
        ? error.message
        : 'The request was not valid.';
    default:
      break;
  }
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return 'This no longer exists, or you are not allowed to see it.';
    }
    if (error.status === 403) return 'You are not allowed to do that here.';
    return error.message;
  }
  return 'Could not reach the server.';
}

export const isNotFound = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;
