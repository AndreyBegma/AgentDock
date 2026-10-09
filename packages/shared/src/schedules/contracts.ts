import type { OrchestratorMode, SkillRunOutput } from '../protocol';

/**
 * HTTP contracts of cron schedules (docs/specs/25-cron-schedules.md "API").
 * A schedule fires a skill run (#24) or an orchestrator start (#17) on one
 * project at the times of a cron expression in an IANA timezone.
 */

/** D1, a skill target: fires `skill.run`. */
export interface ScheduleSkillTarget {
  kind: 'skill';
  /** `<name>` or `<plugin>:<name>` (#24 D8). */
  skill: string;
  args: string;
  /** A `runtime_profiles` id on the project's runner; the project default when absent. */
  profileId?: string;
  /** A model alias or id; `SCHEDULE_DEFAULT_MODEL` when absent. */
  model?: string;
  output: SkillRunOutput;
}

/** D1, an orchestrator target: fires `orchestrator.start` with the project's settings. */
export interface ScheduleOrchestratorTarget {
  kind: 'orchestrator';
  mode: OrchestratorMode;
}

export type ScheduleTarget = ScheduleSkillTarget | ScheduleOrchestratorTarget;

export const SCHEDULE_TARGET_KINDS = ['skill', 'orchestrator'] as const;
export type ScheduleTargetKind = (typeof SCHEDULE_TARGET_KINDS)[number];

/** D1: the skill run default when a skill target names no model. */
export const SCHEDULE_DEFAULT_MODEL = 'opus';

/** D6. `skip` is the default. */
export const SCHEDULE_MISSED_POLICIES = ['skip', 'catch_up'] as const;
export type ScheduleMissedPolicy = (typeof SCHEDULE_MISSED_POLICIES)[number];

export const SCHEDULE_DISABLED_REASONS = [
  'manual',
  'failing',
  'creator_not_authorized',
] as const;
export type ScheduleDisabledReason = (typeof SCHEDULE_DISABLED_REASONS)[number];

/** `cron`: on time; `catch_up`: a missed occurrence fired late (D6); `manual`: run now (D15). */
export const SCHEDULE_FIRING_KINDS = ['cron', 'catch_up', 'manual'] as const;
export type ScheduleFiringKind = (typeof SCHEDULE_FIRING_KINDS)[number];

/**
 * - `due` — claimed, its command not sent yet;
 * - `started` — the runner accepted it; its run is in progress;
 * - `noop` — `orchestrator.start` answered `already_running` (D8);
 * - `skipped` — not fired: missed (D6), overlap (D7) or the pre-fire hook (D12);
 * - `failed` — not started, or its run ended failed;
 * - `succeeded` — its run ended succeeded, or the orchestrator was started.
 */
export const SCHEDULE_FIRING_STATUSES = [
  'due',
  'started',
  'noop',
  'skipped',
  'failed',
  'succeeded',
] as const;
export type ScheduleFiringStatus = (typeof SCHEDULE_FIRING_STATUSES)[number];

/** Why a firing was skipped or failed. Free text is in `error`. */
export const SCHEDULE_FIRING_REASONS = {
  missed: 'missed',
  missedOver24h: 'missed_over_24h',
  previousStillRunning: 'previous_still_running',
  runnerOffline: 'runner_offline',
  creatorNotAuthorized: 'creator_not_authorized',
  alreadyRunning: 'already_running',
  commandFailed: 'command_failed',
  runFailed: 'run_failed',
  denied: 'denied',
} as const;
export type ScheduleFiringReason =
  (typeof SCHEDULE_FIRING_REASONS)[keyof typeof SCHEDULE_FIRING_REASONS];

/** D3: the shortest allowed gap between two firings, checked over the next 10. */
export const SCHEDULE_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const SCHEDULE_INTERVAL_CHECK_COUNT = 10;
/** D6: older than this, a missed occurrence is skipped whatever the policy. */
export const SCHEDULE_CATCH_UP_MAX_MS = 24 * 60 * 60 * 1000;
/** D6: a `nextRunAt` further in the past than this at claim time is missed. */
export const SCHEDULE_MISSED_GRACE_MS = 2 * 60 * 1000;
/** D11. */
export const SCHEDULE_MAX_CONSECUTIVE_FAILURES = 5;
/** The preview's number of fire times. */
export const SCHEDULE_PREVIEW_COUNT = 5;
/** Firings returned with a schedule's detail. */
export const SCHEDULE_DETAIL_FIRINGS = 50;
export const SCHEDULE_NAME_MAX_LENGTH = 100;
export const SCHEDULE_CRON_MAX_LENGTH = 100;

export const SCHEDULES_ERROR = {
  notFound: 'not_found',
  forbidden: 'forbidden',
  invalidCron: 'invalid_cron',
  intervalTooShort: 'interval_too_short',
  invalidTimezone: 'invalid_timezone',
  invalidTarget: 'invalid_target',
} as const;
export type SchedulesErrorCode =
  (typeof SCHEDULES_ERROR)[keyof typeof SCHEDULES_ERROR];

export interface SchedulesErrorBody {
  statusCode: number;
  error: SchedulesErrorCode;
  message: string;
}

/** `POST /projects/:projectId/schedules`. */
export interface ScheduleCreateRequest {
  name: string;
  target: ScheduleTarget;
  cron: string;
  timezone: string;
  missedPolicy?: ScheduleMissedPolicy;
  enabled?: boolean;
}

/** `PATCH /projects/:projectId/schedules/:id` — only the fields sent change. */
export type ScheduleUpdateRequest = Partial<ScheduleCreateRequest>;

/** `POST /schedules/preview`. */
export interface SchedulePreviewRequest {
  cron: string;
  timezone: string;
}

export interface SchedulePreviewView {
  /** The expression in words, e.g. "At 03:00 AM". */
  description: string;
  /** The next `SCHEDULE_PREVIEW_COUNT` fire times, ISO in UTC. */
  next: string[];
}

export interface ScheduleFiringView {
  id: string;
  scheduleId: string;
  scheduledFor: string;
  firedAt: string | null;
  kind: ScheduleFiringKind;
  status: ScheduleFiringStatus;
  reason: string | null;
  missedCount: number;
  /** The `runs` row a skill firing started (#21). */
  runId: string | null;
  /** The `command_runs` row an orchestrator firing wrote (#17). */
  commandRunId: string | null;
  error: unknown;
  finishedAt: string | null;
}

export interface ScheduleView {
  id: string;
  projectId: string;
  name: string;
  target: ScheduleTarget;
  cron: string;
  timezone: string;
  missedPolicy: ScheduleMissedPolicy;
  enabled: boolean;
  disabledReason: ScheduleDisabledReason | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  consecutiveFailures: number;
  createdById: string;
  updatedById: string | null;
  createdAt: string;
  updatedAt: string;
  lastFiring: ScheduleFiringView | null;
}

export interface ScheduleDetail extends ScheduleView {
  /** The last `SCHEDULE_DETAIL_FIRINGS`, newest first. */
  firings: ScheduleFiringView[];
}

/** `/admin/schedules` rows carry their project's name. */
export interface AdminScheduleView extends ScheduleView {
  projectName: string;
}

/** D13: a job of the API's own, read from `@nestjs/schedule`. */
export interface SystemJobView {
  name: string;
  kind: 'cron' | 'interval';
  /** The cron expression; null for an interval. */
  cron: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

/** D17: live events on `project:<id>`. */
export const SCHEDULE_UPDATED_LIVE_EVENT = 'schedule.updated';
export const SCHEDULE_FIRING_UPDATED_LIVE_EVENT = 'schedule_firing.updated';
export const SCHEDULE_FIRED_LIVE_EVENT = 'schedule.fired';
export const SCHEDULE_SKIPPED_LIVE_EVENT = 'schedule.skipped';
export const SCHEDULE_FAILED_LIVE_EVENT = 'schedule.failed';
export const SCHEDULE_DISABLED_LIVE_EVENT = 'schedule.disabled';

/** `schedule.updated` payload; `deleted` when the schedule is gone. Re-read over REST. */
export interface ScheduleLiveChange {
  id: string;
  deleted?: boolean;
}

/** `schedule_firing.updated` and `schedule.fired|skipped|failed` payload. */
export interface ScheduleFiringLiveChange {
  scheduleId: string;
  firingId: string;
  status: ScheduleFiringStatus;
  reason: string | null;
}

/** `schedule.disabled` payload. */
export interface ScheduleDisabledLiveEvent {
  scheduleId: string;
  reason: ScheduleDisabledReason;
}
