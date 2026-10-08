import {
  RUN_STATUSES,
  type RunListQuery,
  type RunStatus,
  type RunSummary,
  type RunUsage,
} from '@agentdock/shared';
import { dayBoundary } from '../activity/format';
import { CHECKS_LABEL } from '../fleet/format';
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

export interface RunFilterForm {
  status: string;
  fromDate: string;
  toDate: string;
}

export const EMPTY_RUN_FILTERS: RunFilterForm = {
  status: '',
  fromDate: '',
  toDate: '',
};

export function toRunQuery(form: RunFilterForm): RunListQuery {
  const query: RunListQuery = {};
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
