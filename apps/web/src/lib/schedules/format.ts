import {
  SCHEDULE_CRON_MAX_LENGTH,
  SCHEDULE_NAME_MAX_LENGTH,
  SCHEDULES_ERROR,
  type ScheduleCreateRequest,
  type ScheduleDisabledReason,
  type ScheduleFiringStatus,
  type ScheduleMissedPolicy,
  type ScheduleTarget,
  type ScheduleView,
} from '@agentdock/shared';
import { ApiError, describeError } from '../api';
import { describeBudgetExceededError } from '../budgets/format';

type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

export const FIRING_STATUS_LABEL: Record<ScheduleFiringStatus, string> = {
  due: 'due',
  started: 'running',
  noop: 'already running',
  skipped: 'skipped',
  failed: 'failed',
  succeeded: 'succeeded',
};

export const FIRING_STATUS_TONE: Record<ScheduleFiringStatus, Tone> = {
  due: 'warn',
  started: 'ok',
  noop: 'neutral',
  skipped: 'neutral',
  failed: 'danger',
  succeeded: 'ok',
};

const FIRING_REASON_LABEL: Record<string, string> = {
  missed: 'missed while the API or runner was down',
  missed_over_24h: 'missed by more than 24 hours',
  previous_still_running: 'the previous run is still going',
  runner_offline: 'the runner was offline',
  creator_not_authorized: 'the creator lost access to the project',
  already_running: 'the orchestrator was already running',
  command_failed: 'the runner refused the command',
  run_failed: 'the run ended failed',
  denied: 'denied before firing',
};

/** A firing's reason as a phrase; unknown codes are shown as they came. */
export const firingReasonLabel = (reason: string | null): string | null =>
  reason === null ? null : (FIRING_REASON_LABEL[reason] ?? reason);

export const DISABLED_REASON_LABEL: Record<ScheduleDisabledReason, string> = {
  manual: 'Disabled by a person.',
  failing: 'Disabled after five failed firings in a row.',
  creator_not_authorized:
    'Disabled: its creator is no longer an operator of this project.',
};

export const MISSED_POLICY_LABEL: Record<ScheduleMissedPolicy, string> = {
  skip: 'Skip',
  catch_up: 'Catch up',
};

export const MISSED_POLICY_HINT: Record<ScheduleMissedPolicy, string> = {
  skip: 'A run missed while the API or runner was down is recorded as skipped.',
  catch_up:
    'Fires once for the newest missed time, if it is less than 24 hours old.',
};

export const SCHEDULE_MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;

/** One line for the table: what the schedule fires. */
export function describeTarget(target: ScheduleTarget): string {
  if (target.kind === 'orchestrator') return `orchestrator ${target.mode}`;
  const args = target.args.trim().replace(/\s+/g, ' ');
  if (args === '') return target.skill;
  return `${target.skill} ${args.length > 60 ? `${args.slice(0, 59)}…` : args}`;
}

/** A fire time in the schedule's own timezone, e.g. `Oct 10, 03:00`; a dash for none. */
export function formatFireTime(
  iso: string | null,
  timezone: string,
  withZone = false,
): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      ...(withZone ? { timeZoneName: 'short' } : {}),
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/** The next-run cell: a disabled schedule has none to show. */
export const nextRunLabel = (schedule: ScheduleView): string =>
  schedule.enabled
    ? formatFireTime(schedule.nextRunAt, schedule.timezone)
    : 'disabled';

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The canonical IANA names the browser knows, plus `UTC` (D4). */
export function timezoneOptions(): string[] {
  try {
    const names = Intl.supportedValuesOf('timeZone');
    return names.includes('UTC') ? names : ['UTC', ...names];
  } catch {
    return ['UTC'];
  }
}

export interface ScheduleForm {
  name: string;
  targetKind: 'skill' | 'orchestrator';
  skill: string;
  args: string;
  /** A runtime profile id; empty = the project default. */
  profileId: string;
  model: string;
  output: 'report' | 'pr';
  mode: 'start' | 'next';
  cron: string;
  timezone: string;
  missedPolicy: ScheduleMissedPolicy;
  enabled: boolean;
}

export const emptyScheduleForm = (timezone: string): ScheduleForm => ({
  name: '',
  targetKind: 'skill',
  skill: '',
  args: '',
  profileId: '',
  model: 'opus',
  output: 'report',
  mode: 'next',
  cron: '0 3 * * *',
  timezone,
  missedPolicy: 'skip',
  enabled: true,
});

export function formFromSchedule(schedule: ScheduleView): ScheduleForm {
  const base = {
    name: schedule.name,
    cron: schedule.cron,
    timezone: schedule.timezone,
    missedPolicy: schedule.missedPolicy,
    enabled: schedule.enabled,
  };
  const target = schedule.target;
  if (target.kind === 'orchestrator') {
    return {
      ...emptyScheduleForm(schedule.timezone),
      ...base,
      targetKind: 'orchestrator',
      mode: target.mode,
    };
  }
  return {
    ...emptyScheduleForm(schedule.timezone),
    ...base,
    targetKind: 'skill',
    skill: target.skill,
    args: target.args,
    profileId: target.profileId ?? '',
    model: target.model ?? 'opus',
    output: target.output,
  };
}

export type ScheduleFormProblem =
  | 'name'
  | 'name_too_long'
  | 'skill'
  | 'model'
  | 'cron'
  | 'cron_fields'
  | 'timezone';

export const SCHEDULE_FORM_PROBLEM_TEXT: Record<ScheduleFormProblem, string> = {
  name: 'Give the schedule a name.',
  name_too_long: `The name is over ${SCHEDULE_NAME_MAX_LENGTH} characters.`,
  skill: 'Pick the skill to run.',
  model: 'Use a model alias or id such as opus.',
  cron: 'Enter a cron expression.',
  cron_fields:
    'Use five fields (minute hour day month weekday), or @hourly, @daily, @weekly, @monthly.',
  timezone: 'Enter an IANA timezone such as Europe/Kyiv.',
};

const CRON_MACROS = new Set(['@hourly', '@daily', '@weekly', '@monthly']);

/**
 * The first thing wrong with the form, by the same cheap rules the API
 * applies first; the API still decides (`invalid_cron`, `interval_too_short`).
 */
export function scheduleFormProblem(
  form: ScheduleForm,
): ScheduleFormProblem | null {
  const name = form.name.trim();
  if (name === '') return 'name';
  if (name.length > SCHEDULE_NAME_MAX_LENGTH) return 'name_too_long';
  if (form.targetKind === 'skill') {
    if (form.skill.trim() === '') return 'skill';
    if (!/^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/.test(form.model.trim())) {
      return 'model';
    }
  }
  const cron = form.cron.trim();
  if (cron === '' || cron.length > SCHEDULE_CRON_MAX_LENGTH) return 'cron';
  if (!CRON_MACROS.has(cron) && cron.split(/\s+/).length !== 5) {
    return 'cron_fields';
  }
  if (form.timezone.trim() === '') return 'timezone';
  return null;
}

export function toScheduleTarget(form: ScheduleForm): ScheduleTarget {
  if (form.targetKind === 'orchestrator') {
    return { kind: 'orchestrator', mode: form.mode };
  }
  return {
    kind: 'skill',
    skill: form.skill.trim(),
    args: form.args,
    model: form.model.trim(),
    output: form.output,
    ...(form.profileId ? { profileId: form.profileId } : {}),
  };
}

export const toScheduleRequest = (
  form: ScheduleForm,
): ScheduleCreateRequest => ({
  name: form.name.trim(),
  target: toScheduleTarget(form),
  cron: form.cron.trim(),
  timezone: form.timezone.trim(),
  missedPolicy: form.missedPolicy,
  enabled: form.enabled,
});

const errorCode = (error: unknown): string | undefined =>
  error instanceof ApiError ? (error.code as string | undefined) : undefined;

export const isNotFound = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;

/** Every schedules error as a sentence for the person. */
export function describeSchedulesError(error: unknown): string {
  const budget = describeBudgetExceededError(error);
  if (budget) return budget;
  switch (errorCode(error)) {
    case SCHEDULES_ERROR.invalidCron:
      return 'That is not a valid cron expression. Use five fields: minute hour day month weekday.';
    case SCHEDULES_ERROR.intervalTooShort:
      return 'That fires more often than every 5 minutes. Agent runs are long and costly; pick a longer interval.';
    case SCHEDULES_ERROR.invalidTimezone:
      return 'That timezone is not known. Use an IANA name such as Europe/Kyiv.';
    case SCHEDULES_ERROR.invalidTarget:
      return 'The target is not valid for this project, for example a profile that belongs to another runner.';
    default:
      break;
  }
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return 'It no longer exists, or you are not a member of this project.';
    }
    if (error.status === 403) return 'Your role does not allow this.';
  }
  return describeError(error);
}
