import type { ChipDef, FilterCodec } from '../filters/url-filters';
import {
  EMPTY_FILTERS,
  ORIGIN_FILTERS,
  ORIGIN_LABEL,
  type SessionFilterForm,
} from './format';

/** The sessions page's filters in the URL (`useUrlFilters`, #213). */
const KEYS = {
  projectId: 'project',
  runtime: 'runtime',
  origin: 'origin',
  fromDate: 'from',
  toDate: 'to',
  model: 'model',
  slot: 'slot',
} as const;

const TEXT_FIELDS = Object.keys(KEYS) as (keyof typeof KEYS)[];
const FIELD_MAX = 200;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RUNTIMES: readonly string[] = ['claude', 'codex'];

export const RUNTIME_LABEL: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

/** Filters from a URL's search; anything unreadable is dropped, not trusted. */
export function sessionFiltersFromSearch(
  params: URLSearchParams,
): SessionFilterForm {
  const form: SessionFilterForm = { ...EMPTY_FILTERS };
  for (const field of TEXT_FIELDS) {
    const value = params.get(KEYS[field])?.trim() ?? '';
    if (!value || value.length > FIELD_MAX) continue;
    if (field === 'runtime' && !RUNTIMES.includes(value)) continue;
    if (
      field === 'origin' &&
      !(ORIGIN_FILTERS as readonly string[]).includes(value)
    ) {
      continue;
    }
    if (
      (field === 'fromDate' || field === 'toDate') &&
      !DAY_PATTERN.test(value)
    ) {
      continue;
    }
    form[field] = value;
  }
  form.unassigned = params.get('unassigned') === '1';
  return form;
}

/** `''` or `?…`, in a stable key order, empty fields left out. */
export function sessionFiltersSearch(form: SessionFilterForm): string {
  const params = new URLSearchParams();
  for (const field of TEXT_FIELDS) {
    const value = form[field].trim();
    if (value) params.set(KEYS[field], value);
  }
  if (form.unassigned) params.set('unassigned', '1');
  const text = params.toString();
  return text ? `?${text}` : '';
}

export const SESSION_FILTER_CODEC: FilterCodec<SessionFilterForm> = {
  keys: [...TEXT_FIELDS.map((field) => KEYS[field]), 'unassigned'],
  parse: sessionFiltersFromSearch,
  search: sessionFiltersSearch,
};

/** How many of the "More filters" fields are set: the count on its trigger. */
export const moreSessionFilterCount = (form: SessionFilterForm): number =>
  [form.fromDate, form.toDate, form.model, form.slot].filter(
    (value) => value.trim() !== '',
  ).length + (form.unassigned ? 1 : 0);

/** The filters as removable chips. */
export const sessionChipDefs = (
  projectName: (id: string) => string,
): ChipDef<SessionFilterForm>[] => [
  {
    key: 'project',
    label: (f) =>
      f.unassigned || !f.projectId
        ? null
        : `Project: ${projectName(f.projectId)}`,
    clear: { projectId: '' },
  },
  {
    key: 'unassigned',
    label: (f) => (f.unassigned ? 'No project' : null),
    clear: { unassigned: false },
  },
  {
    key: 'runtime',
    label: (f) =>
      f.runtime ? `Runtime: ${RUNTIME_LABEL[f.runtime] ?? f.runtime}` : null,
    clear: { runtime: '' },
  },
  {
    key: 'origin',
    label: (f) =>
      f.origin
        ? `Origin: ${ORIGIN_LABEL[f.origin as keyof typeof ORIGIN_LABEL] ?? f.origin}`
        : null,
    clear: { origin: '' },
  },
  {
    key: 'model',
    label: (f) => (f.model.trim() ? `Model: ${f.model.trim()}` : null),
    clear: { model: '' },
  },
  {
    key: 'slot',
    label: (f) => (f.slot.trim() ? `Slot: ${f.slot.trim()}` : null),
    clear: { slot: '' },
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
];
