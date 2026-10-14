import type { UsageBreakdownRow, UsageDimension } from '@agentdock/shared';
import type { ChipDef, FilterCodec } from '../filters/url-filters';
import {
  BREAKDOWN_DIMENSIONS,
  customRange,
  presetRange,
  RANGE_PRESETS,
  type UsageRange,
} from './format';

/**
 * `/usage`'s state in the URL (#213): `?range=today&projectId=…&tz=…&by=slot`,
 * `from`/`to` with `range=custom`. `range=today` is the contract Overview's
 * "Cost today" tile links to.
 */
export const USAGE_PRESETS = ['today', ...RANGE_PRESETS] as const;
export type UsagePreset = (typeof USAGE_PRESETS)[number];

export const USAGE_PRESET_LABEL: Record<UsagePreset, string> = {
  today: 'Today',
  '24h': '24 h',
  '7d': '7 d',
  '30d': '30 d',
  custom: 'Custom',
};

export type BreakdownDimension = (typeof BREAKDOWN_DIMENSIONS)[number];

export interface UsageFilters {
  range: UsagePreset;
  /** `yyyy-mm-dd`, only with `range=custom`. */
  fromDate: string;
  toDate: string;
  /** An IANA zone; `''` is the viewer's own. */
  tz: string;
  projectId: string;
  by: BreakdownDimension;
}

export const DEFAULT_USAGE_FILTERS: UsageFilters = {
  range: '7d',
  fromDate: '',
  toDate: '',
  tz: '',
  projectId: '',
  by: 'project',
};

const KEYS = ['range', 'from', 'to', 'tz', 'projectId', 'by'] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FIELD_MAX = 200;

const oneOf = <T extends string>(
  values: readonly T[],
  value: string,
): T | undefined =>
  (values as readonly string[]).find((v) => v === value) as T | undefined;

/** What the URL says, anything unreadable left at its default. */
export function usageFiltersFromSearch(params: URLSearchParams): UsageFilters {
  const read = (key: string): string => {
    const value = params.get(key)?.trim() ?? '';
    return value.length > FIELD_MAX ? '' : value;
  };
  const range =
    oneOf(USAGE_PRESETS, read('range')) ?? DEFAULT_USAGE_FILTERS.range;
  const from = read('from');
  const to = read('to');
  return {
    range,
    fromDate: range === 'custom' && DAY.test(from) ? from : '',
    toDate: range === 'custom' && DAY.test(to) ? to : '',
    tz: read('tz'),
    projectId: read('projectId'),
    by: oneOf(BREAKDOWN_DIMENSIONS, read('by')) ?? DEFAULT_USAGE_FILTERS.by,
  };
}

/** `''` or `?…`; a default is left out, so a plain `/usage` stays plain. */
export function usageFiltersSearch(filters: UsageFilters): string {
  const params = new URLSearchParams();
  if (filters.range !== DEFAULT_USAGE_FILTERS.range) {
    params.set('range', filters.range);
  }
  if (filters.range === 'custom') {
    if (filters.fromDate) params.set('from', filters.fromDate);
    if (filters.toDate) params.set('to', filters.toDate);
  }
  if (filters.tz) params.set('tz', filters.tz);
  if (filters.projectId) params.set('projectId', filters.projectId);
  if (filters.by !== DEFAULT_USAGE_FILTERS.by) params.set('by', filters.by);
  const text = params.toString();
  return text ? `?${text}` : '';
}

export const USAGE_FILTER_CODEC: FilterCodec<UsageFilters> = {
  keys: KEYS,
  parse: usageFiltersFromSearch,
  search: usageFiltersSearch,
};

const HOUR_MS = 3_600_000;

/** From the viewer's local midnight to the end of the current hour. */
export function todayRange(now: Date = new Date()): UsageRange {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const to = Math.ceil((now.getTime() + 1) / HOUR_MS) * HOUR_MS;
  return { from: midnight.toISOString(), to: new Date(to).toISOString() };
}

/** The API range for the filters; null while a custom range is incomplete. */
export function usageRange(
  filters: Pick<UsageFilters, 'range' | 'fromDate' | 'toDate'>,
  now: Date = new Date(),
): UsageRange | null {
  switch (filters.range) {
    case 'today':
      return todayRange(now);
    case 'custom':
      return customRange(filters.fromDate, filters.toDate);
    default:
      return presetRange(filters.range, now);
  }
}

/**
 * The filters as removable chips. The range and the breakdown are views —
 * always set, never a chip.
 */
export const usageChipDefs = (
  projectName: (id: string) => string,
): ChipDef<UsageFilters>[] => [
  {
    key: 'projectId',
    label: (f) => (f.projectId ? `Project: ${projectName(f.projectId)}` : null),
    clear: { projectId: '' },
  },
  {
    key: 'tz',
    label: (f) => (f.tz ? `Time zone: ${f.tz}` : null),
    clear: { tz: '' },
  },
];

/**
 * Where a breakdown row leads, inside Usage (#213): a project row narrows to
 * that project, by slot; a slot or issue row narrows to its project. Null
 * when the row has nowhere further to go — machine-wide usage, the project
 * already in force, or a model or runtime, which the API cannot filter on.
 */
export function breakdownDrill(
  dimension: UsageDimension,
  row: Pick<UsageBreakdownRow, 'key' | 'projectId'>,
  filters: Pick<UsageFilters, 'projectId'>,
): Partial<UsageFilters> | null {
  if (dimension === 'project') {
    return row.key ? { projectId: row.key, by: 'slot' } : null;
  }
  if (dimension === 'slot' || dimension === 'issue' || dimension === 'run') {
    return row.projectId && row.projectId !== filters.projectId
      ? { projectId: row.projectId }
      : null;
  }
  return null;
}
