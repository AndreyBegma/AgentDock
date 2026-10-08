/**
 * The activity feed (docs/specs/21 D1): one curated row per runner event or
 * audit record worth showing, projected by the API and read newest first.
 */

/** Where an item comes from in the product: the fleet, a runner, the audit log. */
export const ACTIVITY_CATEGORIES = ['fleet', 'runner', 'audit'] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

export const ACTIVITY_SEVERITIES = ['info', 'ok', 'warn', 'danger'] as const;
export type ActivitySeverity = (typeof ACTIVITY_SEVERITIES)[number];

/** Who did it (D5): a user, a runner, the orchestrator, or the system. */
export const ACTIVITY_ACTOR_TYPES = [
  'user',
  'runner',
  'orchestrator',
  'system',
] as const;
export type ActivityActorType = (typeof ACTIVITY_ACTOR_TYPES)[number];

/** The source table of an item: `events` (by `id`) or `audit_records` (by `seq`). */
export const ACTIVITY_SOURCE_KINDS = ['event', 'audit'] as const;
export type ActivitySourceKind = (typeof ACTIVITY_SOURCE_KINDS)[number];

export const ACTIVITY_PAGE_DEFAULT = 50;
export const ACTIVITY_PAGE_MAX = 200;

/** Largest `data` of an item, in bytes of JSON (spec 21 schema). */
export const ACTIVITY_DATA_MAX_BYTES = 4096;

/** Days an item is kept before the daily job deletes it (D6). */
export const ACTIVITY_RETENTION_DAYS_DEFAULT = 180;

/** Live event on `project:<id>`, or on `admin` for a project-less item (D9). */
export const ACTIVITY_ITEM_LIVE_EVENT = 'activity.item';

/** One feed item as the API returns it and pushes it live. */
export interface ActivityItem {
  /** BigInt in the database — a decimal string here. */
  id: string;
  ts: string;
  /** null: runner- or user-level — visible to admins only (D4). */
  projectId: string | null;
  category: ActivityCategory;
  /** The source event type or audit action. */
  type: string;
  severity: ActivitySeverity;
  title: string;
  actorType: ActivityActorType;
  /** User id, runner id, or null (orchestrator, system, an unknown user). */
  actorId: string | null;
  /** The actor's current email, for a user actor that still exists. */
  actorEmail: string | null;
  slot: string | null;
  issue: number | null;
  prNumber: number | null;
  /** An in-app path to open, when there is one. */
  link: string | null;
  /** A few safe fields of the source, ≤ `ACTIVITY_DATA_MAX_BYTES`; never secrets. */
  data: Record<string, unknown>;
}

export interface ActivityPage {
  items: ActivityItem[];
  /** Pass as `cursor` for the next (older) page; null on the last page. */
  nextCursor: string | null;
}

/**
 * `GET /activity` and `GET /projects/:projectId/activity`. `from`/`to` bound
 * `ts` (ISO, `to` exclusive). `actor` matches `actorId`. `cursor` is the
 * `nextCursor` of the previous page; pages stay stable while newer items are
 * inserted (D11).
 */
export interface ActivityQuery {
  /** Global feed only: one project of the caller's. */
  projectId?: string;
  category?: ActivityCategory;
  type?: string;
  actor?: string;
  slot?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

export const ACTIVITY_ERROR = {
  badCursor: 'bad_cursor',
  notFound: 'not_found',
} as const;
export type ActivityErrorCode =
  (typeof ACTIVITY_ERROR)[keyof typeof ACTIVITY_ERROR];

export interface ActivityErrorBody {
  statusCode: number;
  error: ActivityErrorCode;
  message: string;
}
