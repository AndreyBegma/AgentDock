import {
  type ActivityActorType,
  RUN_KINDS,
  RUN_STATUSES,
  type RunKind,
  type RunListQuery,
  type RunStatus,
  type RunSummary,
  type RunUsage,
} from '@nautelle/shared';
import { dayBoundary } from '../activity/format';
import type { ChipDef, FilterCodec } from '../filters/url-filters';
import { CHECKS_LABEL } from '../fleet/format';
import { formatDate, formatNumber } from '../format';
import { formatCost, formatDuration, formatTokens } from '../sessions/format';

type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

export const RUN_STATUS_TONE: Record<RunStatus, Tone> = {
  running: 'ok',
  blocked: 'danger',
  waiting_person: 'warn',
  succeeded: 'ok',
  failed: 'danger',
  abandoned: 'neutral',
};

/** Sentence case, as every `StatusPill` label (#213). */
export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  running: 'Running',
  blocked: 'Blocked',
  waiting_person: 'Waiting for a person',
  succeeded: 'Succeeded',
  failed: 'Failed',
  abandoned: 'Abandoned',
};

export const isRunStatus = (value: string): value is RunStatus =>
  (RUN_STATUSES as readonly string[]).includes(value);

/** What started a run, in words (rule R5): never the enum or a `replace('_', ' ')`. */
export const RUN_KIND_LABEL: Record<RunKind, string> = {
  orchestrator_slot: 'Orchestrator slot',
  skill: 'Skill run',
  schedule: 'Scheduled start',
  plan: 'Planner turn',
  ui_profile: 'UI profile build',
  card: 'Board card round',
  card_capture: 'Card capture',
  text_normalize: 'Text translation',
  card_assess: 'Card model assessment',
  steward: 'Steward check',
  code_ask: 'Assistant code question',
  ui_profile_learn: 'UI profile learning',
  rules_compress: 'Rules compression',
  prefix_propose: 'Prefix overlay proposal',
  card_review: 'Card review step',
};

export const isRunKind = (value: string): value is RunKind =>
  (RUN_KINDS as readonly string[]).includes(value);

/** History's filters, as the URL holds them (#213). Dates are `YYYY-MM-DD`. */
export interface RunFilters {
  kind: RunKind | '';
  status: RunStatus | '';
  from: string;
  to: string;
}

const RUN_FILTER_KEYS = ['kind', 'status', 'from', 'to'] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** An unknown kind, status or date is ignored, not an error: a link may be old. */
export function runFiltersFromSearch(params: URLSearchParams): RunFilters {
  const read = (key: string) => params.get(key)?.trim() ?? '';
  const kind = read('kind');
  const status = read('status');
  const from = read('from');
  const to = read('to');
  return {
    kind: isRunKind(kind) ? kind : '',
    status: isRunStatus(status) ? status : '',
    from: DATE.test(from) ? from : '',
    to: DATE.test(to) ? to : '',
  };
}

/** `''` or `?…`, in a stable key order, empty fields left out. */
export function runFiltersSearch(filters: RunFilters): string {
  const params = new URLSearchParams();
  for (const key of RUN_FILTER_KEYS) {
    if (filters[key]) params.set(key, filters[key]);
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** A `YYYY-MM-DD` as the local day it names, not UTC midnight. */
const dayLabel = (day: string): string =>
  formatDate(dayBoundary(day, false) ?? day, 'date');

/** History's filters in the URL (`useUrlFilters`); `?kind=skill` comes from Skills. */
export const RUN_FILTER_CODEC: FilterCodec<RunFilters> = {
  keys: RUN_FILTER_KEYS,
  parse: runFiltersFromSearch,
  search: runFiltersSearch,
};

/** Whether any filter narrows the list; decides "no matches" versus "nothing yet". */
export const hasRunFilters = (filters: RunFilters): boolean =>
  RUN_FILTER_KEYS.some((key) => filters[key] !== '');

/** What "Clear all" and the empty state's "Clear filters" write. */
export const NO_RUN_FILTERS: RunFilters = {
  kind: '',
  status: '',
  from: '',
  to: '',
};

/**
 * The toolbar's removable chips. Status is not among them: it has its own row
 * of counted chips, and a chip there is how it is cleared.
 */
export const RUN_CHIP_DEFS: ChipDef<RunFilters>[] = [
  {
    key: 'kind',
    label: (f) => (f.kind ? `Kind: ${RUN_KIND_LABEL[f.kind]}` : null),
    clear: { kind: '' },
  },
  {
    key: 'from',
    label: (f) => (f.from ? `From ${dayLabel(f.from)}` : null),
    clear: { from: '' },
  },
  {
    key: 'to',
    label: (f) => (f.to ? `To ${dayLabel(f.to)}` : null),
    clear: { to: '' },
  },
];

/** The `GET /runs` query of the filters: the `to` day is included. */
export function toRunQuery(filters: RunFilters): RunListQuery {
  const query: RunListQuery = {};
  if (filters.kind) query.kind = filters.kind;
  if (filters.status) query.status = filters.status;
  const from = dayBoundary(filters.from, false);
  const to = dayBoundary(filters.to, true);
  if (from) query.from = from;
  if (to) query.to = to;
  return query;
}

/** The Runs tab of a project's Activity (C-285), which took over History. */
export function runsHref(
  projectId: string,
  filters: Partial<RunFilters> = {},
): string {
  const params = new URLSearchParams({ tab: 'runs' });
  for (const key of RUN_FILTER_KEYS) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  return `/projects/${projectId}/activity?${params}`;
}

/** One run, open beside the Runs tab: a sheet on a phone, a panel from tablet up. */
export const runHref = (projectId: string, runId: string): string =>
  `/projects/${projectId}/activity?tab=runs&run=${encodeURIComponent(runId)}`;

/**
 * Where an old `/history` or `/history/:runId` link lands: the Runs tab, with
 * the filters it carried (an unknown one is dropped) and the run open.
 */
export function historyRedirectTarget(
  projectId: string,
  search: Record<string, string | string[] | undefined>,
  runId?: string,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    const text = Array.isArray(value) ? value[0] : value;
    if (text !== undefined) params.set(key, text);
  }
  const target = runsHref(projectId, runFiltersFromSearch(params));
  return runId ? `${target}&run=${encodeURIComponent(runId)}` : target;
}

/** The status chips, in the order a person scans for trouble. */
export const RUN_STATUS_CHIPS: readonly RunStatus[] = [
  'running',
  'blocked',
  'waiting_person',
  'failed',
  'succeeded',
  'abandoned',
];

/** Runs under the chips' filters: the "All" chip's count. */
export const totalRuns = (counts: Record<RunStatus, number>): number =>
  RUN_STATUSES.reduce((sum, status) => sum + (counts[status] ?? 0), 0);

/** "#42 · i42" — the issue and the slot; whichever exists. */
export function runLabel(run: Pick<RunSummary, 'issue' | 'slot' | 'title'>) {
  const parts: string[] = [];
  if (run.issue !== null) parts.push(`#${run.issue}`);
  if (run.slot) parts.push(run.slot);
  return parts.length > 0 ? parts.join(' · ') : (run.title ?? 'run');
}

/**
 * A run's title, never blank: its own title, else the issue and slot, else the
 * kind in words ("Skill run").
 */
export function runTitle(
  run: Pick<RunSummary, 'issue' | 'slot' | 'title' | 'kind'>,
): string {
  if (run.title?.trim()) return run.title.trim();
  const label = runLabel({ ...run, title: null });
  return label === 'run' ? RUN_KIND_LABEL[run.kind] : label;
}

/**
 * Abandoned runs are noise in a list (a slot that was dropped, not a result):
 * hidden unless the person filtered for them or asked to see them.
 */
export function splitAbandoned<T extends Pick<RunSummary, 'status'>>(
  runs: readonly T[],
  show: boolean,
): { visible: T[]; hidden: number } {
  if (show) return { visible: [...runs], hidden: 0 };
  const visible = runs.filter((run) => run.status !== 'abandoned');
  return { visible, hidden: runs.length - visible.length };
}

/** "43 abandoned runs hidden" — the toggle's sentence. */
export const abandonedHiddenLabel = (count: number): string =>
  `${formatNumber(count)} abandoned ${count === 1 ? 'run' : 'runs'} hidden`;

/** glass-ui's badge is 10 px; a status in a table reads at 12 px (issue #159). */
export const READABLE_BADGE = 'h-5 px-2 text-xs';

/** The words a screen reader gets for the icon that stands for who acted. */
export const ACTOR_LABEL: Record<ActivityActorType, string> = {
  user: 'Person',
  runner: 'Runner',
  orchestrator: 'Orchestrator',
  system: 'System',
};

export function runtimeLabel(
  run: Pick<RunSummary, 'runtime' | 'model'>,
): string {
  return [run.runtime, run.model].filter(Boolean).join(' / ') || '—';
}

/** "PR #9 · checks green"; "—" with no PR. */
export function prLabel(
  run: Pick<RunSummary, 'prNumber' | 'prChecks'>,
): string {
  if (run.prNumber === null) return '—';
  return run.prChecks
    ? `PR #${run.prNumber} · ${CHECKS_LABEL[run.prChecks]}`
    : `PR #${run.prNumber}`;
}

export const usageTokens = (usage: RunUsage): number =>
  usage.input +
  usage.output +
  usage.cacheRead +
  usage.cacheWrite5m +
  usage.cacheWrite1h;

export const tokensLabel = (usage: RunUsage): string =>
  usage.requests === 0 ? '—' : formatTokens(usageTokens(usage));

/**
 * Cost of a run (spec 21 D8): `null` with unpriced requests is "unpriced",
 * not zero. Partly priced shows the sum and how many are missing.
 */
export function costLabel(usage: RunUsage): string {
  if (usage.requests === 0) return '—';
  if (usage.costUsd === null) return 'unpriced';
  const cost = formatCost(usage.costUsd);
  return usage.unpricedRequests > 0
    ? `${cost} + ${usage.unpricedRequests} unpriced`
    : cost;
}

/**
 * The line under a run's title on the Runs timeline (C-285): History's
 * columns — kind, runtime, PR, duration, tokens and cost — with the empty
 * ones left out. The start is the row's time and its day heading.
 */
export function runFacts(
  run: Pick<
    RunSummary,
    | 'kind'
    | 'runtime'
    | 'model'
    | 'prNumber'
    | 'prChecks'
    | 'durationMs'
    | 'usage'
  >,
): string {
  return [
    RUN_KIND_LABEL[run.kind],
    runtimeLabel(run),
    prLabel(run),
    formatDuration(run.durationMs),
    run.usage.requests === 0 ? '—' : `${tokensLabel(run.usage)} tokens`,
    costLabel(run.usage),
  ]
    .filter((part) => part !== '—')
    .join(' · ');
}

/** What went wrong with a run, for the banner its page leads with (#213). */
export interface RunFailure {
  tone: 'danger' | 'warn';
  title: string;
  /** The runner's or the worker's own words; markdown for a checkpoint. */
  cause: string;
  /** The runner does not know the command: only an update fixes it. */
  updateRunner: boolean;
}

const UNKNOWN_COMMAND = /\bunknown[_ ]command\b/i;

/**
 * The banner of a run that did not get where it was going: failed, blocked or
 * abandoned. A slot run fails on its PR; any other run carries the runner's
 * error in `outcome`. Null for a run that is fine.
 */
export function runFailure(
  run: Pick<RunSummary, 'kind' | 'status' | 'outcome' | 'prNumber'>,
): RunFailure | null {
  const outcome = run.outcome?.trim() || null;
  const updateRunner = outcome !== null && UNKNOWN_COMMAND.test(outcome);
  const slot = run.kind === 'orchestrator_slot';
  switch (run.status) {
    case 'failed':
      return {
        tone: 'danger',
        title: 'This run failed',
        cause:
          slot && run.prNumber !== null
            ? `Pull request #${run.prNumber} was closed without being merged.`
            : (outcome ?? 'The runner reported no reason.'),
        updateRunner,
      };
    case 'blocked':
      return {
        tone: 'warn',
        title: 'The worker is blocked',
        cause: outcome ?? 'The worker reported a block without a reason.',
        updateRunner,
      };
    case 'abandoned':
      return {
        tone: 'warn',
        title: 'This run was abandoned',
        cause: slot
          ? 'The worker’s session ended without a pull request.'
          : (outcome ?? 'It ended before it finished.'),
        updateRunner,
      };
    default:
      return null;
  }
}

/** Where to try a run again: its plan, or the skill's run dialog. None for a slot. */
export function retryHref(
  projectId: string,
  run: Pick<RunSummary, 'kind' | 'status' | 'planId' | 'title'>,
): string | null {
  if (run.status !== 'failed' && run.status !== 'abandoned') return null;
  if (run.kind === 'plan' && run.planId) {
    return `/projects/${projectId}/planner/${run.planId}`;
  }
  const skill = run.kind === 'skill' ? run.title?.replace(/^\//, '') : null;
  return skill
    ? `/projects/${projectId}/skills?run=${encodeURIComponent(skill)}`
    : null;
}

/** The newest agent session of a run: the one "Open session" opens. */
export function latestSession<T extends { startedAt: string }>(
  sessions: readonly T[],
): T | null {
  let latest: T | null = null;
  for (const session of sessions) {
    if (!latest || session.startedAt > latest.startedAt) latest = session;
  }
  return latest;
}

export interface RunLiveUpdate {
  id: string;
  status: RunStatus;
}

/** Narrows a `run.updated` payload. */
export function parseRunUpdate(data: unknown): RunLiveUpdate | null {
  if (typeof data !== 'object' || data === null) return null;
  const { id, status } = data as { id?: unknown; status?: unknown };
  if (typeof id !== 'string' || typeof status !== 'string') return null;
  return isRunStatus(status) ? { id, status } : null;
}
