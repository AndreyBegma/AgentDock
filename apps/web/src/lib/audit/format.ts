import {
  AUDIT_ERROR,
  type AuditFilters,
  type AuditRecordView,
  type AuditResult,
  type AuditVerification,
} from '@agentdock/shared';
import { ApiError, describeError } from '../api';

type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

export const RESULT_TONE: Record<AuditResult, Tone> = {
  ok: 'ok',
  requested: 'neutral',
  denied: 'warn',
  error: 'danger',
};

/** Filters as the form holds them: strings, empty meaning "not set". */
export interface AuditFilterForm {
  fromDate: string;
  toDate: string;
  action: string;
  actorUserId: string;
  result: string;
  targetType: string;
  targetId: string;
  projectId: string;
}

export const EMPTY_FILTERS: AuditFilterForm = {
  fromDate: '',
  toDate: '',
  action: '',
  actorUserId: '',
  result: '',
  targetType: '',
  targetId: '',
  projectId: '',
};

/** `yyyy-mm-dd` from a date input, as a local-time instant. */
function dayBoundary(date: string, end: boolean): string | undefined {
  if (!date) return undefined;
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) return undefined;
  const instant = end
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day);
  return instant.toISOString();
}

export function toFilters(form: AuditFilterForm): AuditFilters {
  const filters: AuditFilters = {};
  const from = dayBoundary(form.fromDate, false);
  const to = dayBoundary(form.toDate, true);
  if (from) filters.from = from;
  if (to) filters.to = to;
  if (form.action) filters.action = form.action;
  if (form.actorUserId) filters.actorUserId = form.actorUserId;
  if (form.result) filters.result = form.result as AuditResult;
  if (form.targetType.trim()) filters.targetType = form.targetType.trim();
  if (form.targetId.trim()) filters.targetId = form.targetId.trim();
  if (form.projectId.trim()) filters.projectId = form.projectId.trim();
  return filters;
}

export function filtersQuery(
  filters: AuditFilters,
  extra: Record<string, string | number | undefined> = {},
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, ...extra })) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** Prefixes of the action union (`runner.`, `auth.`, …) for the action filter. */
export function actionGroups(actions: readonly string[]): string[] {
  return [...new Set(actions.map((a) => `${a.split('.')[0]}.`))];
}

export function actorLabel(record: AuditRecordView): string {
  switch (record.actorType) {
    case 'user':
      return record.actorEmail ?? record.actorUserId ?? 'deleted user';
    case 'runner':
      return `runner ${record.actorRunnerId ?? ''}`.trim();
    default:
      return record.actorType;
  }
}

export function targetLabel(record: AuditRecordView): string {
  return record.targetId
    ? `${record.targetType} · ${record.targetId}`
    : record.targetType;
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function describeVerification(v: AuditVerification): string {
  return v.ok
    ? `Chain verified — ${v.checked} records, ${formatTime(v.verifiedAt)}`
    : `Chain broken at seq ${v.firstBrokenSeq ?? '?'} — ${formatTime(v.verifiedAt)}`;
}

export function prettyJson(value: unknown): string {
  return value === null || value === undefined
    ? '—'
    : JSON.stringify(value, null, 2);
}

export function describeAuditError(error: unknown): string {
  if (error instanceof ApiError && error.code === AUDIT_ERROR.notFound) {
    return 'That record no longer exists.';
  }
  if (error instanceof ApiError && error.status === 400) {
    return `Invalid filter: ${error.message}`;
  }
  return describeError(error);
}
