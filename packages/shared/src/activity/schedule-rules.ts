import { API_EVENT_SOURCE } from '../protocol/envelope';
import {
  SCHEDULE_DISABLED_LIVE_EVENT,
  SCHEDULE_FAILED_LIVE_EVENT,
  SCHEDULE_FIRED_LIVE_EVENT,
  SCHEDULE_SKIPPED_LIVE_EVENT,
  type ScheduleEventType,
} from '../schedules/contracts';
import { type EventContext, type EventRule, fixed, int, str } from './rules';

/**
 * `schedule.*` events the API records itself (spec 25 D17, ADR-0014): actor
 * `system`, only from `source` `api` — a runner can never send that source,
 * so it can never forge one of these items.
 */

const named = (ctx: EventContext): string => {
  const name = str(ctx.data, 'scheduleName');
  return name ? `Schedule “${name}”` : 'Schedule';
};

/** `: <reason>` with underscores read as spaces, or nothing. */
const because = (ctx: EventContext, key: string): string => {
  const reason = str(ctx.data, key);
  return reason ? `: ${reason.replaceAll('_', ' ')}` : '';
};

const FIRED_HOW: Record<string, string> = {
  catch_up: ' (catch-up)',
  manual: ' (run now)',
};

const KEEP = [
  'scheduleId',
  'scheduleName',
  'firingId',
  'status',
  'reason',
  'kind',
  'scheduledFor',
  'missedCount',
  'runId',
  'disabledReason',
] as const;

const scheduleRule = (
  rule: Pick<EventRule, 'severity' | 'title'>,
): EventRule => ({
  category: 'fleet',
  keep: KEEP,
  bySystem: true,
  sources: [API_EVENT_SOURCE],
  link: (ctx) =>
    ctx.projectId ? `/projects/${ctx.projectId}/schedules` : null,
  ...rule,
});

export const SCHEDULE_EVENT_RULES: Record<ScheduleEventType, EventRule> = {
  [SCHEDULE_FIRED_LIVE_EVENT]: scheduleRule({
    severity: fixed('ok'),
    title: (ctx) =>
      `${named(ctx)} fired${FIRED_HOW[str(ctx.data, 'kind') ?? ''] ?? ''}${
        str(ctx.data, 'status') === 'noop' ? ': already running' : ''
      }`,
  }),
  [SCHEDULE_SKIPPED_LIVE_EVENT]: scheduleRule({
    severity: fixed('info'),
    title: (ctx) => {
      const missed = int(ctx.data, 'missedCount');
      const count = missed !== null && missed > 1 ? ` ${missed} times` : '';
      return `${named(ctx)} skipped${count}${because(ctx, 'reason')}`;
    },
  }),
  [SCHEDULE_FAILED_LIVE_EVENT]: scheduleRule({
    severity: fixed('danger'),
    title: (ctx) => `${named(ctx)} failed${because(ctx, 'reason')}`,
  }),
  [SCHEDULE_DISABLED_LIVE_EVENT]: scheduleRule({
    severity: fixed('danger'),
    title: (ctx) => `${named(ctx)} disabled${because(ctx, 'disabledReason')}`,
  }),
};
