import type { TimelineItem } from '@andrewbehma/glass-ui/timeline';
import {
  ACTIVITY_AUDIT_ACTIONS,
  ACTIVITY_CATEGORIES,
  ACTIVITY_EVENT_TYPES,
  type ActivityCategory,
  type ActivityItem,
  type ActivityQuery,
  type ActivitySeverity,
  MAX_LIVE_SUBSCRIPTIONS,
  STEWARD_ACTIVITY_TYPES,
} from '@nautelle/shared';
import { ApiError } from '../api';
import type { ChipDef, FilterCodec } from '../filters/url-filters';
import { isSlotName } from '../fleet/workspace-url';
import { internalHref } from '../url';

/** Projects the global feed follows live; past it the page polls (the socket is shared, cap 50). */
export const LIVE_PROJECT_BUDGET = 10;
export const POLL_MS = 15_000;
export const PAGE_SIZE = 50;
/** A feed scrolled further than this keeps new items behind the "N new" pill. */
export const SCROLLED_PX = 80;

export const CATEGORY_LABEL: Record<ActivityCategory, string> = {
  fleet: 'Fleet',
  runner: 'Runner',
  audit: 'Audit',
};

export const isCategory = (value: string): value is ActivityCategory =>
  (ACTIVITY_CATEGORIES as readonly string[]).includes(value);

const TONE: Record<ActivitySeverity, NonNullable<TimelineItem['tone']>> = {
  info: 'neutral',
  ok: 'ok',
  warn: 'warn',
  danger: 'danger',
};

export const severityTone = (
  severity: ActivitySeverity,
): NonNullable<TimelineItem['tone']> => TONE[severity];

/** Filters as the form holds them: strings, empty meaning "not set". */
export interface ActivityFilterForm {
  projectId: string;
  category: string;
  type: string;
  actor: string;
  slot: string;
  fromDate: string;
  toDate: string;
}

export const EMPTY_ACTIVITY_FILTERS: ActivityFilterForm = {
  projectId: '',
  category: '',
  type: '',
  actor: '',
  slot: '',
  fromDate: '',
  toDate: '',
};

/** `yyyy-mm-dd` from a date input as a local-time instant; `to` is exclusive. */
export function dayBoundary(
  date: string,
  nextDay: boolean,
): string | undefined {
  if (!date) return undefined;
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) return undefined;
  return new Date(year, month - 1, day + (nextDay ? 1 : 0)).toISOString();
}

export function toActivityQuery(form: ActivityFilterForm): ActivityQuery {
  const query: ActivityQuery = {};
  if (form.projectId) query.projectId = form.projectId;
  if (isCategory(form.category)) query.category = form.category;
  if (form.type.trim()) query.type = form.type.trim();
  if (form.actor.trim()) query.actor = form.actor.trim();
  if (form.slot.trim()) query.slot = form.slot.trim();
  const from = dayBoundary(form.fromDate, false);
  const to = dayBoundary(form.toDate, true);
  if (from) query.from = from;
  if (to) query.to = to;
  return query;
}

/** Whether a query narrows the feed at all (none: "nothing yet", some: "no matches"). */
export const hasActivityFilters = (query: ActivityQuery): boolean =>
  Object.values(query).some((value) => value !== undefined && value !== '');

const FORM_KEYS: Record<keyof ActivityFilterForm, string> = {
  projectId: 'project',
  category: 'category',
  type: 'type',
  actor: 'actor',
  slot: 'slot',
  fromDate: 'from',
  toDate: 'to',
};

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FIELD_MAX = 200;

/**
 * The filters as the page URL holds them (`?category=fleet&from=2026-10-01`):
 * days, not instants, so a shared link means the same days to its reader.
 * Anything unreadable is dropped.
 */
export function formFromSearch(params: URLSearchParams): ActivityFilterForm {
  const form = { ...EMPTY_ACTIVITY_FILTERS };
  for (const [field, key] of Object.entries(FORM_KEYS) as [
    keyof ActivityFilterForm,
    string,
  ][]) {
    const value = params.get(key)?.trim() ?? '';
    if (!value || value.length > FIELD_MAX) continue;
    if (field === 'category' && !isCategory(value)) continue;
    if (
      (field === 'fromDate' || field === 'toDate') &&
      !DAY_PATTERN.test(value)
    )
      continue;
    form[field] = value;
  }
  return form;
}

/** The URL search for a form: `''` or `?…`, in a stable key order. */
export function formSearch(form: ActivityFilterForm): string {
  const params = new URLSearchParams();
  for (const [field, key] of Object.entries(FORM_KEYS) as [
    keyof ActivityFilterForm,
    string,
  ][]) {
    const value = form[field].trim();
    if (value) params.set(key, value);
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** How many of the "More filters" fields are set: the count on its trigger. */
export const moreFilterCount = (form: ActivityFilterForm): number =>
  [form.type, form.actor, form.slot, form.fromDate, form.toDate].filter(
    (value) => value.trim() !== '',
  ).length;

const TYPE_WORDS: Record<string, string> = {
  pr: 'PR',
  prs: 'PRs',
  ci: 'CI',
  github: 'GitHub',
};

/**
 * A readable name for an event code: `pr.checks_changed` → "PR checks
 * changed". The code itself is for tooltips only (#159 R2).
 */
export function typeLabel(type: string): string {
  const words = type.split(/[._-]+/).filter(Boolean);
  if (words.length === 0) return type;
  return words
    .map(
      (word, i) =>
        TYPE_WORDS[word] ??
        (i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word),
    )
    .join(' ');
}

const STEWARD_TYPE_LABEL: Record<string, string> = {
  'steward_incident.opened': 'Incident opened',
  'steward_incident.acted': 'Action taken',
  'steward_incident.escalated': 'Needs you',
  'steward_incident.resolved': 'Resolved',
};

/**
 * #447 D15: the **Steward** group of the Type filter — the incident events
 * (category Fleet), in the order an incident moves. The feed filters by one
 * type at a time.
 */
export const STEWARD_TYPE_OPTIONS: readonly { value: string; label: string }[] =
  STEWARD_ACTIVITY_TYPES.map((value) => ({
    value,
    label: STEWARD_TYPE_LABEL[value] ?? typeLabel(value),
  }));

const isStewardType = (value: string): boolean =>
  (STEWARD_ACTIVITY_TYPES as readonly string[]).includes(value);

/** The Type filter's options: every other code the feed shows, by readable name. */
export const TYPE_OPTIONS: readonly { value: string; label: string }[] = [
  ...new Set([...ACTIVITY_EVENT_TYPES, ...ACTIVITY_AUDIT_ACTIONS]),
]
  .filter((value) => !isStewardType(value))
  .map((value) => ({ value, label: typeLabel(value) }))
  .sort((a, b) => a.label.localeCompare(b.label));

/** One row of the feed: an item, or a run of items about one slot or PR. */
export type FeedRow =
  | { kind: 'item'; item: ActivityItem }
  | {
      kind: 'group';
      /** Stable while newer items arrive: the oldest item's id. */
      id: string;
      /** "i154" or "PR #157". */
      label: string;
      /** Newest first, as the feed. */
      items: ActivityItem[];
    };

const localDay = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/** What an item is about, for grouping: its slot, else its PR, else nothing. */
const subject = (item: ActivityItem): string | null =>
  item.slot
    ? `slot:${item.slot}`
    : item.prNumber !== null
      ? `pr:${item.prNumber}`
      : null;

const subjectLabel = (item: ActivityItem): string =>
  item.slot ?? `PR #${item.prNumber}`;

/**
 * Folds consecutive items of one local day about the same slot (or the same
 * PR when there is no slot) into one group row. A lone item stays an item.
 */
export function groupRows(items: readonly ActivityItem[]): FeedRow[] {
  const rows: FeedRow[] = [];
  let run: ActivityItem[] = [];
  const flush = () => {
    if (run.length === 1) rows.push({ kind: 'item', item: run[0] });
    else if (run.length > 1) {
      rows.push({
        kind: 'group',
        id: `group-${(run.at(-1) as ActivityItem).id}`,
        label: subjectLabel(run[0]),
        items: run,
      });
    }
    run = [];
  };
  for (const item of items) {
    const key = subject(item);
    const head = run[0];
    if (
      head &&
      key !== null &&
      key === subject(head) &&
      localDay(item.ts) === localDay(head.ts)
    ) {
      run.push(item);
      continue;
    }
    flush();
    run = [item];
  }
  flush();
  return rows;
}

export function queryString(
  query: object,
  extra: { cursor?: string; limit?: number } = {},
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...query, ...extra })) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** Whether a live item passes the filters the page is showing (the API filters pages, we filter pushes). */
export function matchesQuery(
  item: ActivityItem,
  query: ActivityQuery,
): boolean {
  if (query.projectId && item.projectId !== query.projectId) return false;
  if (query.category && item.category !== query.category) return false;
  if (query.type && item.type !== query.type) return false;
  if (query.actor && item.actorId !== query.actor) return false;
  if (query.slot && item.slot !== query.slot) return false;
  const at = Date.parse(item.ts);
  if (query.from && at < Date.parse(query.from)) return false;
  if (query.to && at >= Date.parse(query.to)) return false;
  return true;
}

/** Newest first by `(ts, id)`, as the API pages. */
const newer = (a: ActivityItem, b: ActivityItem): number => {
  const byTs = Date.parse(b.ts) - Date.parse(a.ts);
  if (byTs !== 0) return byTs;
  const x = BigInt(a.id);
  const y = BigInt(b.id);
  return x === y ? 0 : y > x ? 1 : -1;
};

/** Adds `incoming` to `current` without duplicates, keeping the API's order. */
export function mergeItems(
  current: ActivityItem[],
  incoming: ActivityItem[],
): ActivityItem[] {
  const seen = new Set(current.map((item) => item.id));
  const fresh: ActivityItem[] = [];
  for (const item of incoming) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    fresh.push(item);
  }
  if (fresh.length === 0) return current;
  return [...current, ...fresh].sort(newer);
}

/** Narrows a `activity.item` push payload; anything else is ignored. */
export function parseLiveItem(data: unknown): ActivityItem | null {
  if (typeof data !== 'object' || data === null) return null;
  const item = data as Partial<ActivityItem>;
  if (
    typeof item.id !== 'string' ||
    !/^\d+$/.test(item.id) ||
    typeof item.ts !== 'string' ||
    Number.isNaN(Date.parse(item.ts)) ||
    typeof item.title !== 'string' ||
    typeof item.type !== 'string' ||
    typeof item.category !== 'string' ||
    typeof item.severity !== 'string'
  ) {
    return null;
  }
  return item as ActivityItem;
}

export interface LivePlan {
  topics: (`project:${string}` | 'admin')[];
  /** True when the feed cannot follow everything live and must poll instead. */
  poll: boolean;
}

/**
 * Which topics the feed follows. One project (fixed or filtered) is always
 * live. The global feed follows up to `budget` projects, plus `admin` for an
 * admin (project-less items); past the budget it polls and subscribes to
 * nothing, so the shared socket never nears `MAX_LIVE_SUBSCRIPTIONS`.
 */
export function planLive(
  scope: { projectId?: string; projectIds: string[]; isAdmin: boolean },
  budget = Math.min(LIVE_PROJECT_BUDGET, MAX_LIVE_SUBSCRIPTIONS - 1),
): LivePlan {
  if (scope.projectId) {
    return { topics: [`project:${scope.projectId}`], poll: false };
  }
  if (scope.projectIds.length > budget) return { topics: [], poll: true };
  const topics: LivePlan['topics'] = scope.projectIds.map(
    (id) => `project:${id}` as const,
  );
  if (scope.isAdmin) topics.push('admin');
  return { topics, poll: false };
}

/** Who caused an item, by name; a runner by its name when `runnerNames` knows it (R2). */
export function actorName(
  item: ActivityItem,
  runnerNames?: ReadonlyMap<string, string>,
): string | null {
  switch (item.actorType) {
    case 'user':
      return item.actorEmail ?? 'unknown user';
    case 'runner':
      return (item.actorId && runnerNames?.get(item.actorId)) || 'runner';
    case 'orchestrator':
      return 'orchestrator';
    case 'system':
      return 'system';
  }
}

export function itemMeta(
  item: ActivityItem,
  projectNames?: ReadonlyMap<string, string>,
): string {
  const parts: string[] = [CATEGORY_LABEL[item.category] ?? item.category];
  if (item.projectId && projectNames) {
    parts.push(projectNames.get(item.projectId) ?? 'a project');
  } else if (!item.projectId) {
    parts.push('no project');
  }
  if (item.slot) parts.push(`slot ${item.slot}`);
  if (item.issue !== null) parts.push(`#${item.issue}`);
  const { prNumber } = itemTitle(item);
  if (prNumber !== null) parts.push(`PR #${prNumber}`);
  return parts.join(' · ');
}

/** An in-app link only: the API sends paths, but the page does not trust it. */
export const safeLink = (link: string | null): string | undefined =>
  link?.startsWith('/') ? internalHref(link) : undefined;

/**
 * Where a row opens (#213). An item about a slot whose link is its project's
 * Fleet opens that slot's panel in front (`?open=<slot>&focus=<slot>`, the
 * workspace URL of #160); any other link is the API's, as it is.
 */
export function activityHref(
  item: Pick<ActivityItem, 'link' | 'projectId' | 'slot'>,
): string | undefined {
  const link = safeLink(item.link);
  if (!link || !item.projectId || !item.slot || !isSlotName(item.slot)) {
    return link;
  }
  if (link !== `/projects/${item.projectId}/fleet`) return link;
  const slot = encodeURIComponent(item.slot);
  return `${link}?open=${slot}&focus=${slot}`;
}

/** A GitHub pull request URL at the end of a title, with what leads into it. */
const TRAILING_PR_URL = /\s*(?:[—–:-]\s*)?https?:\/\/\S+?\/pull\/(\d+)\S*\s*$/;

/**
 * The title without a raw pull request URL, and the PR's number for a
 * `#205` chip (#213). A checkpoint heading such as "pull request open —
 * https://github.com/o/r/pull/205" reads "pull request open"; the number
 * comes from the item, else from the URL.
 */
export function itemTitle(item: Pick<ActivityItem, 'title' | 'prNumber'>): {
  title: string;
  prNumber: number | null;
} {
  const match = TRAILING_PR_URL.exec(item.title);
  const fromUrl = match ? Number(match[1]) : null;
  const title = match ? item.title.slice(0, match.index).trim() : item.title;
  return {
    title: title || item.title,
    prNumber: item.prNumber ?? fromUrl,
  };
}

/**
 * Where an item's pull request lives: the `prUrl` the checkpoint carried, else
 * the URL at the end of the title. https only — the data is not trusted.
 */
export function prLink(
  item: Pick<ActivityItem, 'title' | 'data'>,
): string | undefined {
  const fromData = item.data?.prUrl;
  const candidate =
    typeof fromData === 'string'
      ? fromData
      : TRAILING_PR_URL.exec(item.title)?.[0]
          .trim()
          .replace(/^[—–:-]\s*/, '');
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** `/activity`'s filters in the URL (`useUrlFilters`). */
export const ACTIVITY_FILTER_CODEC: FilterCodec<ActivityFilterForm> = {
  keys: Object.values(FORM_KEYS),
  parse: formFromSearch,
  search: formSearch,
};

/** A project's feed: the project is the page's, never a filter in its URL. */
export const PROJECT_ACTIVITY_FILTER_CODEC: FilterCodec<ActivityFilterForm> = {
  keys: Object.values(FORM_KEYS).filter((key) => key !== FORM_KEYS.projectId),
  parse: (params) => ({ ...formFromSearch(params), projectId: '' }),
  search: (form) => formSearch({ ...form, projectId: '' }),
};

/** The filters in force as removable chips, named the way the selects name them. */
export const activityChipDefs = (names: {
  project: (id: string) => string;
  actor: (id: string) => string;
}): ChipDef<ActivityFilterForm>[] => [
  {
    key: 'project',
    label: (f) =>
      f.projectId ? `Project: ${names.project(f.projectId)}` : null,
    clear: { projectId: '' },
  },
  {
    key: 'category',
    label: (f) =>
      isCategory(f.category) ? `Category: ${CATEGORY_LABEL[f.category]}` : null,
    clear: { category: '' },
  },
  {
    key: 'type',
    label: (f) => (f.type.trim() ? `Type: ${typeLabel(f.type.trim())}` : null),
    clear: { type: '' },
  },
  {
    key: 'actor',
    label: (f) => (f.actor.trim() ? `Actor: ${names.actor(f.actor)}` : null),
    clear: { actor: '' },
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

export function toTimelineItem(
  item: ActivityItem,
  projectNames?: ReadonlyMap<string, string>,
  runnerNames?: ReadonlyMap<string, string>,
): TimelineItem {
  const name = actorName(item, runnerNames);
  return {
    id: item.id,
    at: item.ts,
    tone: severityTone(item.severity),
    actor: name ? { name } : undefined,
    title: itemTitle(item).title,
    meta: itemMeta(item, projectNames),
    href: activityHref(item),
  };
}

export const isNotFound = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;
