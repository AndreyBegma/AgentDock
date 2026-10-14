import {
  WORKFLOW_AGENT_TYPE,
  WORKFLOW_AGENT_TYPE_MAX_LENGTH,
  WORKFLOW_COMPACTION_BUCKETS,
  WORKFLOW_ERROR,
  WORKFLOW_OUTCOMES,
  WORKFLOW_STATUSES,
  type WorkflowCompactionBucket,
  type WorkflowNodeFilter,
  type WorkflowOutcome,
  type WorkflowSankeyNode,
  type WorkflowStatus,
  type WorkflowToolFlow,
} from '@agentdock/shared';
import type { Runtime } from '@agentdock/shared/protocol';
import { ApiError, describeError } from '../api';
import type { ChipDef, FilterCodec } from '../filters/url-filters';
import { APP_LOCALE, formatDuration, formatNumber } from '../format';
import {
  customRange,
  presetRange,
  RANGE_PRESETS,
  type RangePreset,
  type UsageRange,
} from '../usage/format';

/* ── filters: the URL is the state ──────────────────────────────────── */

const RUNTIMES: readonly Runtime[] = ['claude', 'codex'];

/** The Sankey's node filters, in the order the chips show them. */
export const NODE_FILTER_KEYS = [
  'runtime',
  'agentType',
  'compactions',
  'outcome',
] as const;
export type NodeFilterKey = (typeof NODE_FILTER_KEYS)[number];

/** Filters as the URL holds them: strings, empty meaning "not set". */
export interface WorkflowsFilters {
  range: RangePreset;
  /** `yyyy-mm-dd`, both inclusive; read only when `range` is `custom`. */
  fromDate: string;
  toDate: string;
  projectId: string;
  profileKey: string;
  status: WorkflowStatus;
  runtime: Runtime | '';
  agentType: string;
  compactions: WorkflowCompactionBucket | '';
  outcome: WorkflowOutcome | '';
}

export const DEFAULT_WORKFLOWS_FILTERS: WorkflowsFilters = {
  range: '7d',
  fromDate: '',
  toDate: '',
  projectId: '',
  profileKey: '',
  status: 'all',
  runtime: '',
  agentType: '',
  compactions: '',
  outcome: '',
};

const FIELD_MAX = 200;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const oneOf = <T extends string>(
  list: readonly T[],
  value: string,
): T | undefined => list.find((item) => item === value);

/**
 * Filters from a URL's search. A value the page does not know is dropped,
 * not trusted: the API would answer it with a 400 the person cannot fix.
 * `from` and `to` together mean a custom range, whatever `range` says.
 */
export function filtersFromSearch(params: URLSearchParams): WorkflowsFilters {
  const read = (key: string, max = FIELD_MAX): string => {
    const value = params.get(key)?.trim() ?? '';
    return value.length > max ? '' : value;
  };
  const date = (key: string) => {
    const value = read(key);
    return DATE.test(value) ? value : '';
  };
  const fromDate = date('from');
  const toDate = date('to');
  const preset = oneOf(RANGE_PRESETS, read('range'));
  // Both days, or a custom range still being picked (`range=custom`).
  const custom = (fromDate !== '' && toDate !== '') || preset === 'custom';
  return {
    range: custom ? 'custom' : (preset ?? DEFAULT_WORKFLOWS_FILTERS.range),
    fromDate: custom ? fromDate : '',
    toDate: custom ? toDate : '',
    projectId: read('projectId'),
    profileKey: read('profileKey'),
    status: oneOf(WORKFLOW_STATUSES, read('status')) ?? 'all',
    runtime: oneOf(RUNTIMES, read('runtime')) ?? '',
    agentType: read('agentType', WORKFLOW_AGENT_TYPE_MAX_LENGTH),
    compactions: oneOf(WORKFLOW_COMPACTION_BUCKETS, read('compactions')) ?? '',
    outcome: oneOf(WORKFLOW_OUTCOMES, read('outcome')) ?? '',
  };
}

/** `''` or `?…`, in a stable key order; a default is left out of the URL. */
export function filtersSearch(filters: WorkflowsFilters): string {
  const params = new URLSearchParams();
  if (filters.range === 'custom') {
    if (filters.fromDate) params.set('from', filters.fromDate);
    if (filters.toDate) params.set('to', filters.toDate);
    if (!filters.fromDate || !filters.toDate) params.set('range', 'custom');
  } else if (filters.range !== DEFAULT_WORKFLOWS_FILTERS.range) {
    params.set('range', filters.range);
  }
  if (filters.projectId) params.set('projectId', filters.projectId);
  if (filters.profileKey) params.set('profileKey', filters.profileKey);
  if (filters.status !== 'all') params.set('status', filters.status);
  for (const key of NODE_FILTER_KEYS) {
    if (filters[key]) params.set(key, filters[key]);
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** The instants the filters cover; null while a custom range is incomplete. */
export function rangeOf(
  filters: WorkflowsFilters,
  now: Date = new Date(),
): UsageRange | null {
  return filters.range === 'custom'
    ? customRange(filters.fromDate, filters.toDate)
    : presetRange(filters.range, now);
}

/** The query every workflows route takes, empty fields left out. */
export function workflowsQuery(
  filters: WorkflowsFilters,
  range: UsageRange,
  extra: Record<string, string | number> = {},
): string {
  const params = new URLSearchParams({ from: range.from, to: range.to });
  if (filters.projectId) params.set('projectId', filters.projectId);
  if (filters.profileKey) params.set('profileKey', filters.profileKey);
  if (filters.status !== 'all') params.set('status', filters.status);
  for (const key of NODE_FILTER_KEYS) {
    if (filters[key]) params.set(key, filters[key]);
  }
  for (const [key, value] of Object.entries(extra)) {
    params.set(key, String(value));
  }
  return `?${params.toString()}`;
}

/** `/workflows`'s filters in the URL (`useUrlFilters`). */
export const WORKFLOWS_FILTER_CODEC: FilterCodec<WorkflowsFilters> = {
  keys: [
    'range',
    'from',
    'to',
    'projectId',
    'profileKey',
    'status',
    ...NODE_FILTER_KEYS,
  ],
  parse: filtersFromSearch,
  search: filtersSearch,
};

/**
 * The filters in force as removable chips (#213): the project, the runtime
 * profile and every graph filter. The range and the status are views —
 * always set, never a chip.
 */
export const workflowsChipDefs = (names: {
  project: (id: string) => string;
  profile: (key: string) => string;
}): ChipDef<WorkflowsFilters>[] => [
  {
    key: 'projectId',
    label: (f) =>
      f.projectId ? `Project: ${names.project(f.projectId)}` : null,
    // A profile key belongs to one project's runner: it goes with it.
    clear: { projectId: '', profileKey: '' },
  },
  {
    key: 'profileKey',
    label: (f) =>
      f.profileKey ? `Runtime profile: ${names.profile(f.profileKey)}` : null,
    clear: { profileKey: '' },
  },
  ...NODE_FILTER_KEYS.map(
    (key): ChipDef<WorkflowsFilters> => ({
      key,
      label: (f) =>
        nodeFilterChips(f).find((chip) => chip.key === key)?.label ?? null,
      clear: { [key]: '' },
    }),
  ),
];

export const hasNodeFilters = (filters: WorkflowsFilters): boolean =>
  NODE_FILTER_KEYS.some((key) => filters[key] !== '');

export const clearNodeFilters = (
  filters: WorkflowsFilters,
): WorkflowsFilters => ({
  ...filters,
  runtime: '',
  agentType: '',
  compactions: '',
  outcome: '',
});

export const clearNodeFilter = (
  filters: WorkflowsFilters,
  key: NodeFilterKey,
): WorkflowsFilters => ({ ...filters, [key]: '' });

/** One node filter written into the filters, each key with its own type. */
function setNodeFilter(
  filters: WorkflowsFilters,
  filter: WorkflowNodeFilter,
): WorkflowsFilters {
  switch (filter.key) {
    case 'runtime':
      return { ...filters, runtime: filter.value };
    case 'agentType':
      return { ...filters, agentType: filter.value };
    case 'compactions':
      return { ...filters, compactions: filter.value };
    case 'outcome':
      return { ...filters, outcome: filter.value };
  }
}

/**
 * A node click. The node's filter is set; clicking a node already filtered on
 * clears it again. The origin node filters nothing, so it clears every node
 * filter — "back to all sessions".
 */
export function applyNodeFilter(
  filters: WorkflowsFilters,
  node: Pick<WorkflowSankeyNode, 'filter'>,
): WorkflowsFilters {
  const { filter } = node;
  if (!filter) return clearNodeFilters(filters);
  if (filters[filter.key] === filter.value) {
    return clearNodeFilter(filters, filter.key);
  }
  return setNodeFilter(filters, filter);
}

/* ── labels ─────────────────────────────────────────────────────────── */

/**
 * The status segment. `ended` is "Ended", not the issue's "Completed": an
 * ended session can also have failed or been abandoned, and "Completed" is
 * already one of the outcomes on the same page.
 */
export const STATUS_LABEL: Record<WorkflowStatus, string> = {
  all: 'All sessions',
  active: 'Active only',
  ended: 'Ended',
};

export const RUNTIME_LABEL: Record<Runtime, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

export const OUTCOME_LABEL: Record<WorkflowOutcome, string> = {
  completed: 'Completed',
  error: 'Error',
  abandoned: 'Abandoned',
  active: 'Active',
};

export const COMPACTIONS_LABEL: Record<WorkflowCompactionBucket, string> = {
  none: 'No compaction',
  one: '1 compaction',
  many: '2+ compactions',
};

export function agentTypeLabel(value: string): string {
  switch (value) {
    case WORKFLOW_AGENT_TYPE.none:
      return 'No subagents';
    case WORKFLOW_AGENT_TYPE.unknown:
      return 'Unknown type';
    case WORKFLOW_AGENT_TYPE.other:
      return 'Other types';
    default:
      return value;
  }
}

const NODE_FILTER_NAME: Record<NodeFilterKey, string> = {
  runtime: 'Main agent',
  agentType: 'Subagent type',
  compactions: 'Compactions',
  outcome: 'Outcome',
};

export interface NodeFilterChip {
  key: NodeFilterKey;
  /** "Outcome: Error". */
  label: string;
}

/** The node filters that are set, as the chips above the graphs read them. */
export function nodeFilterChips(filters: WorkflowsFilters): NodeFilterChip[] {
  const chips: NodeFilterChip[] = [];
  if (filters.runtime) {
    chips.push({
      key: 'runtime',
      label: `${NODE_FILTER_NAME.runtime}: ${RUNTIME_LABEL[filters.runtime]}`,
    });
  }
  if (filters.agentType) {
    chips.push({
      key: 'agentType',
      label: `${NODE_FILTER_NAME.agentType}: ${agentTypeLabel(filters.agentType)}`,
    });
  }
  if (filters.compactions) {
    chips.push({
      key: 'compactions',
      label: `${NODE_FILTER_NAME.compactions}: ${COMPACTIONS_LABEL[filters.compactions]}`,
    });
  }
  if (filters.outcome) {
    chips.push({
      key: 'outcome',
      label: `${NODE_FILTER_NAME.outcome}: ${OUTCOME_LABEL[filters.outcome]}`,
    });
  }
  return chips;
}

/* ── tiles ──────────────────────────────────────────────────────────── */

/** A tile with no data reads "—", never 0 (the contract's null). */
export const NO_VALUE = '—';

/**
 * Always `digits` decimals (#213): "0.0" beside "0.3", so a rounded-down
 * average never reads as an exact zero next to its neighbours.
 */
export const formatAverage = (value: number | null, digits = 1): string =>
  value === null
    ? NO_VALUE
    : value.toLocaleString(APP_LOCALE, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });

/** "Updated 16:44": the minute is enough for a figure that moves every 35 s. */
export const formatUpdatedAt = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? ''
    : at.toLocaleTimeString(APP_LOCALE, {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
};

/** 0–1 → "87.5%". */
export const formatRate = (value: number | null): string =>
  value === null ? NO_VALUE : `${formatNumber(value * 100, 1)}%`;

export const formatFlow = (flow: WorkflowToolFlow | null): string =>
  flow ? `${flow.from} → ${flow.to}` : NO_VALUE;

/**
 * An average, so whole minutes once past one: "23 min", "2 h 07 min".
 * Seconds on an average are noise, and they do not fit a tile.
 */
export function formatAverageDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return NO_VALUE;
  if (ms < MINUTE_MS) return formatDuration(ms) || NO_VALUE;
  const minutes = Math.round(ms / MINUTE_MS);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

const MINUTE_MS = 60_000;

/** Each tile's one-line hint; its definition is behind the tile's ⓘ. */
export const TILE_SUMMARY = {
  depth: 'Deepest subagent nesting',
  subagents: 'Per root session, any depth',
  successRate: 'Completed ÷ ended — abandoned is not a success',
  topToolFlow: 'Within one turn',
  compactions: 'Per session tree',
  duration: 'Start to last event',
} as const;

/** Each tile's definition, as the contract states it. */
export const TILE_HINT = {
  depth:
    'The deepest subagent nesting per session: 0 without subagents, 1 when the main agent spawned some, 2 when one of those spawned its own.',
  subagents: 'Subagent sessions below each root session, at any depth.',
  successRate:
    'Completed ÷ ended sessions. An abandoned session is not a success; active sessions are left out.',
  topToolFlow:
    'The most frequent pair of consecutive tool calls within one turn.',
  compactions: 'Context compactions per session, over its whole subagent tree.',
  duration: "From the root session's start to the last event in its tree.",
} as const;

/* ── errors ─────────────────────────────────────────────────────────── */

export const isWorkflowsNotFound = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;

export function describeWorkflowsError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return 'That project does not exist, or you are not a member of it.';
    }
    if ((error.code as string | undefined) === WORKFLOW_ERROR.invalidRange) {
      return error.message;
    }
    if (error.status === 400) return error.message;
  }
  return describeError(error);
}
