import {
  AUDIT_ACTIONS,
  AUDIT_RESULTS,
  type AuditResult,
} from '@nautelle/shared';
import {
  actionGroupLabel,
  actionLabel,
  RESULT_LABEL,
} from '../../../lib/audit/actions';
import type { AuditFilterForm } from '../../../lib/audit/format';
import type { ChipDef, FilterCodec } from '../../../lib/filters/url-filters';

/**
 * The Audit page's filters in the URL (#213):
 * `?action=runner.&result=failure&actor=<id>&from=2026-10-01&to=…`, plus
 * `targetType`, `targetId` and `projectId` under "More filters". The form's
 * strings are what the URL holds; `toFilters` turns them into the API query.
 */
const KEYS = [
  'action',
  'result',
  'actor',
  'from',
  'to',
  'targetType',
  'targetId',
  'projectId',
] as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FIELD_MAX = 320;

const isAction = (value: string): boolean =>
  (AUDIT_ACTIONS as readonly string[]).includes(value) ||
  // A group prefix such as `runner.` matches every action under it.
  AUDIT_ACTIONS.some(
    (action) => value.endsWith('.') && action.startsWith(value),
  );

/** What the URL says; anything unreadable is "not set". */
export function auditFiltersFromSearch(
  params: URLSearchParams,
): AuditFilterForm {
  const read = (key: string): string => {
    const value = params.get(key)?.trim() ?? '';
    return value.length > FIELD_MAX ? '' : value;
  };
  const action = read('action');
  const result = read('result');
  const from = read('from');
  const to = read('to');
  return {
    action: isAction(action) ? action : '',
    result: (AUDIT_RESULTS as readonly string[]).includes(result) ? result : '',
    actorUserId: read('actor'),
    fromDate: DAY.test(from) ? from : '',
    toDate: DAY.test(to) ? to : '',
    targetType: read('targetType'),
    targetId: read('targetId'),
    projectId: read('projectId'),
  };
}

/** `''` or `?…`; a filter that is not set is left out. */
export function auditFiltersSearch(form: AuditFilterForm): string {
  const params = new URLSearchParams();
  if (form.action) params.set('action', form.action);
  if (form.result) params.set('result', form.result);
  if (form.actorUserId) params.set('actor', form.actorUserId);
  if (form.fromDate) params.set('from', form.fromDate);
  if (form.toDate) params.set('to', form.toDate);
  if (form.targetType) params.set('targetType', form.targetType);
  if (form.targetId) params.set('targetId', form.targetId);
  if (form.projectId) params.set('projectId', form.projectId);
  const text = params.toString();
  return text ? `?${text}` : '';
}

export const AUDIT_FILTER_CODEC: FilterCodec<AuditFilterForm> = {
  keys: KEYS,
  parse: auditFiltersFromSearch,
  search: auditFiltersSearch,
};

/** How many of the filters under "More filters" are set. */
export const moreFilterCount = (form: AuditFilterForm): number =>
  [
    form.fromDate,
    form.toDate,
    form.targetType,
    form.targetId,
    form.projectId,
  ].filter(Boolean).length;

/** The filters as removable chips; the actor by name once it is known. */
export const auditChipDefs = (
  actorName: (id: string) => string,
): ChipDef<AuditFilterForm>[] => [
  {
    key: 'action',
    label: (f) =>
      f.action
        ? `Action: ${
            f.action.endsWith('.')
              ? `All ${actionGroupLabel(f.action)}`
              : actionLabel(f.action)
          }`
        : null,
    clear: { action: '' },
  },
  {
    key: 'result',
    label: (f) =>
      f.result
        ? `Result: ${RESULT_LABEL[f.result as AuditResult] ?? f.result}`
        : null,
    clear: { result: '' },
  },
  {
    key: 'actor',
    label: (f) => (f.actorUserId ? `Actor: ${actorName(f.actorUserId)}` : null),
    clear: { actorUserId: '' },
  },
  {
    key: 'from',
    label: (f) => (f.fromDate ? `From ${f.fromDate}` : null),
    clear: { fromDate: '' },
  },
  {
    key: 'to',
    label: (f) => (f.toDate ? `To ${f.toDate}` : null),
    clear: { toDate: '' },
  },
  {
    key: 'targetType',
    label: (f) => (f.targetType ? `Target type: ${f.targetType}` : null),
    clear: { targetType: '' },
  },
  {
    key: 'targetId',
    label: (f) => (f.targetId ? `Target id: ${f.targetId}` : null),
    clear: { targetId: '' },
  },
  {
    key: 'projectId',
    label: (f) => (f.projectId ? `Project: ${f.projectId}` : null),
    clear: { projectId: '' },
  },
];
