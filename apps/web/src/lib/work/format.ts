import {
  type BoardCardKind,
  isWorkSource,
  isWorkStatus,
  PLAN_TASK_KINDS,
  PLAN_TASK_LIVE_STATUSES,
  PLAN_TASK_STATUSES,
  type WorkItem,
  type WorkSource,
  type WorkStatus,
  workStatusOfTaskStatus,
} from '@agentdock/shared';
import type { Status } from '@andrewbehma/glass-ui/status-pill';
import type { ChipDef, FilterCodec } from '../filters/url-filters';

/** The filters of `/work`, all kept in the URL (D10). */
export interface WorkFilters {
  projectId: string;
  source: WorkSource | '';
  kind: BoardCardKind | '';
  status: WorkStatus | '';
  planId: string;
  q: string;
}

export const EMPTY_WORK_FILTERS: WorkFilters = {
  projectId: '',
  source: '',
  kind: '',
  status: '',
  planId: '',
  q: '',
};

const FILTER_KEYS = [
  'projectId',
  'source',
  'kind',
  'status',
  'planId',
  'q',
] as const;

const FIELD_MAX = 200;

export const WORK_SOURCE_LABEL: Record<WorkSource, string> = {
  card: 'Card',
  plan: 'Plan',
  inbox: 'Suggested',
};

export const WORK_KIND_LABEL: Record<BoardCardKind, string> = {
  feature: 'Feature',
  bug: 'Bug',
};

export const WORK_STATUS_LABEL: Record<WorkStatus, string> = {
  inbox: 'Inbox',
  todo: 'To Do',
  in_progress: 'In progress',
  finished: 'Finished',
  completed: 'Completed',
  rejected: 'Rejected',
};

/** The shared status scale, so a row reads like a slot or a run in the same state. */
export const WORK_PILL_STATUS: Record<WorkStatus, Status> = {
  inbox: 'waiting',
  todo: 'idle',
  in_progress: 'running',
  finished: 'waiting',
  completed: 'done',
  rejected: 'idle',
};

const isKind = (value: string): value is BoardCardKind =>
  (PLAN_TASK_KINDS as readonly string[]).includes(value);

/** Filters from a URL's search; an unknown source, kind or status is dropped, not trusted. */
export function filtersFromSearch(params: URLSearchParams): WorkFilters {
  const read = (key: string): string => {
    const value = params.get(key)?.trim() ?? '';
    return value.length > FIELD_MAX ? '' : value;
  };
  const source = read('source');
  const kind = read('kind');
  const status = read('status');
  return {
    projectId: read('projectId'),
    source: isWorkSource(source) ? source : '',
    kind: isKind(kind) ? kind : '',
    status: isWorkStatus(status) ? status : '',
    planId: read('planId'),
    q: read('q'),
  };
}

/** `''` or `?…`, in a stable key order, empty fields left out. */
export function filtersSearch(filters: WorkFilters): string {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = filters[key].trim();
    if (value) params.set(key, value);
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export const hasWorkFilters = (filters: WorkFilters): boolean =>
  FILTER_KEYS.some((key) => filters[key].trim() !== '');

export const WORK_FILTER_CODEC: FilterCodec<WorkFilters> = {
  keys: FILTER_KEYS,
  parse: filtersFromSearch,
  search: filtersSearch,
};

/**
 * The filters as removable chips. The plan has no select — it comes in on a
 * link from a plan — so its chip is the only place it shows.
 */
export const workChipDefs = (
  projectName: (id: string) => string,
): ChipDef<WorkFilters>[] => [
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
    key: 'source',
    label: (f) => (f.source ? `Source: ${WORK_SOURCE_LABEL[f.source]}` : null),
    clear: { source: '' },
  },
  {
    key: 'status',
    label: (f) => (f.status ? `Status: ${WORK_STATUS_LABEL[f.status]}` : null),
    clear: { status: '' },
  },
  {
    key: 'kind',
    label: (f) => (f.kind ? `Kind: ${WORK_KIND_LABEL[f.kind]}` : null),
    clear: { kind: '' },
  },
  {
    key: 'planId',
    label: (f) => (f.planId ? 'One plan' : null),
    clear: { planId: '' },
  },
];

/** The `GET /work` query for the filters and a page cursor. */
export function workQuery(filters: WorkFilters, cursor?: string): string {
  const params = new URLSearchParams();
  if (filters.projectId) params.set('projectId', filters.projectId);
  if (filters.source) params.set('source', filters.source);
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.status) params.set('status', filters.status);
  if (filters.planId) params.set('planId', filters.planId);
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (cursor) params.set('cursor', cursor);
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** A row's identity: a card's id, a plan task's id; a plan task and a card never share one. */
export const workRowId = (item: WorkItem): string =>
  item.source === 'plan' ? `plan:${item.taskId}` : `card:${item.cardId}`;

/** Pages loaded one after another merge by row id, so a refetch never doubles a row. */
export function mergeWorkItems(
  current: readonly WorkItem[],
  next: readonly WorkItem[],
): WorkItem[] {
  const seen = new Set(current.map(workRowId));
  return [...current, ...next.filter((item) => !seen.has(workRowId(item)))];
}

const OLD_STATUSES: readonly string[] = [
  ...PLAN_TASK_STATUSES,
  ...PLAN_TASK_LIVE_STATUSES,
];

/**
 * D13: `/tasks?…` as `/work?source=plan&…` — `projectId`, `kind`, `q` and
 * `planId` carry over; the old `status` (a plan or live status) maps through
 * D2 to the column vocabulary, an unknown one is dropped.
 */
export function tasksRedirectTarget(
  search: Record<string, string | string[] | undefined>,
): string {
  const first = (key: string): string => {
    const value = search[key];
    const text = Array.isArray(value) ? value[0] : value;
    return text?.trim() ?? '';
  };
  const params = new URLSearchParams({ source: 'plan' });
  const projectId = first('projectId');
  if (projectId) params.set('projectId', projectId);
  const kind = first('kind');
  if (isKind(kind)) params.set('kind', kind);
  const q = first('q');
  if (q) params.set('q', q.slice(0, FIELD_MAX));
  const planId = first('planId');
  if (planId) params.set('planId', planId);
  const status = first('status');
  if (OLD_STATUSES.includes(status)) {
    params.set(
      'status',
      workStatusOfTaskStatus(status as (typeof PLAN_TASK_STATUSES)[number]),
    );
  }
  return `/work?${params.toString()}`;
}
