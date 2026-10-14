import {
  type ActivityActorType,
  RUN_KINDS,
  RUN_STATUSES,
  type RunKind,
  type RunListQuery,
  type RunStatus,
  type RunSummary,
  type RunUsage,
} from '@agentdock/shared';
import { dayBoundary } from '../activity/format';
import { CHECKS_LABEL } from '../fleet/format';
import { formatNumber } from '../format';
import { formatCost, formatTokens } from '../sessions/format';

type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

export const RUN_STATUS_TONE: Record<RunStatus, Tone> = {
  running: 'ok',
  blocked: 'danger',
  waiting_person: 'warn',
  succeeded: 'ok',
  failed: 'danger',
  abandoned: 'neutral',
};

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  running: 'running',
  blocked: 'blocked',
  waiting_person: 'waiting for a person',
  succeeded: 'succeeded',
  failed: 'failed',
  abandoned: 'abandoned',
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
};

export const isRunKind = (value: string): value is RunKind =>
  (RUN_KINDS as readonly string[]).includes(value);

export interface RunFilterForm {
  kind: string;
  status: string;
  fromDate: string;
  toDate: string;
}

export const EMPTY_RUN_FILTERS: RunFilterForm = {
  kind: '',
  status: '',
  fromDate: '',
  toDate: '',
};

/** The form a `?kind=` link opens with: an unknown kind is ignored, not an error. */
export const runFiltersFromKind = (kind: string | null): RunFilterForm => ({
  ...EMPTY_RUN_FILTERS,
  kind: kind !== null && isRunKind(kind) ? kind : '',
});

/** Whether any filter narrows the list; decides "no matches" versus "nothing yet". */
export const hasRunFilters = (form: RunFilterForm): boolean =>
  Object.values(form).some((value) => value !== '');

/** The filters typed but not applied yet (rule: filter forms show unapplied changes). */
export const runFiltersDirty = (
  form: RunFilterForm,
  applied: RunListQuery,
): boolean => JSON.stringify(toRunQuery(form)) !== JSON.stringify(applied);

export function toRunQuery(form: RunFilterForm): RunListQuery {
  const query: RunListQuery = {};
  if (isRunKind(form.kind)) query.kind = form.kind;
  if (isRunStatus(form.status)) query.status = form.status;
  const from = dayBoundary(form.fromDate, false);
  const to = dayBoundary(form.toDate, true);
  if (from) query.from = from;
  if (to) query.to = to;
  return query;
}

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
