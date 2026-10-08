import {
  ACTIVITY_CATEGORIES,
  type ActivityCategory,
  type ActivityItem,
  type ActivityQuery,
  type ActivitySeverity,
  MAX_LIVE_SUBSCRIPTIONS,
} from '@agentdock/shared';
import type { TimelineItem } from 'glass-ui/timeline';
import { ApiError } from '../api';

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

export function actorName(item: ActivityItem): string | null {
  switch (item.actorType) {
    case 'user':
      return item.actorEmail ?? 'unknown user';
    case 'runner':
      return item.actorId ? `runner ${item.actorId.slice(0, 8)}` : 'runner';
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
  if (item.prNumber !== null) parts.push(`PR #${item.prNumber}`);
  parts.push(item.type);
  return parts.join(' · ');
}

/** An in-app link only: the API sends paths, but the page does not trust it. */
export const safeLink = (link: string | null): string | undefined =>
  link?.startsWith('/') && !link.startsWith('//') ? link : undefined;

export function toTimelineItem(
  item: ActivityItem,
  projectNames?: ReadonlyMap<string, string>,
): TimelineItem {
  const name = actorName(item);
  return {
    id: item.id,
    at: item.ts,
    tone: severityTone(item.severity),
    actor: name ? { name } : undefined,
    title: item.title,
    meta: itemMeta(item, projectNames),
    href: safeLink(item.link),
  };
}

export const isNotFound = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;
