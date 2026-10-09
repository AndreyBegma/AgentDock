import { CronError, CronSchedule, isValidTimezone } from './cron';
import { planClaim } from './missed';

const iso = (dates: (Date | null)[]) => dates.map((d) => d?.toISOString());
const at = (s: string) => new Date(s);

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof CronError) return error.code;
    throw error;
  }
  return undefined;
};

describe('CronSchedule.parse', () => {
  const now = at('2026-10-09T12:00:00Z');

  it('stores 03:00 Kyiv as 00:00 UTC in summer time (D4)', () => {
    const schedule = CronSchedule.parse('0 3 * * *', 'Europe/Kyiv', now);
    expect(iso(schedule.take(now, 2))).toEqual([
      '2026-10-10T00:00:00.000Z',
      '2026-10-11T00:00:00.000Z',
    ]);
  });

  it('refuses intervals under five minutes (D3)', () => {
    expect(codeOf(() => CronSchedule.parse('* * * * *', 'UTC', now))).toBe(
      'interval_too_short',
    );
    expect(codeOf(() => CronSchedule.parse('*/2 * * * *', 'UTC', now))).toBe(
      'interval_too_short',
    );
    expect(codeOf(() => CronSchedule.parse('*/5 * * * *', 'UTC', now))).toBe(
      undefined,
    );
  });

  it('refuses six fields, garbage and unknown macros (D2)', () => {
    for (const cron of [
      '0 0 3 * * *',
      'nope',
      '61 * * * *',
      '@reboot',
      '@yearly',
      '',
    ]) {
      expect(codeOf(() => CronSchedule.parse(cron, 'UTC', now))).toBe(
        'invalid_cron',
      );
    }
  });

  it('refuses an expression that never fires', () => {
    expect(codeOf(() => CronSchedule.parse('0 0 31 2 *', 'UTC', now))).toBe(
      'invalid_cron',
    );
  });

  it('accepts the D2 macros', () => {
    const schedule = CronSchedule.parse('@daily', 'UTC', now);
    expect(schedule.after(now)?.toISOString()).toBe('2026-10-10T00:00:00.000Z');
    expect(CronSchedule.parse('@hourly', 'UTC', now).after(now)).toEqual(
      at('2026-10-09T13:00:00Z'),
    );
  });

  it('validates the timezone (D4)', () => {
    expect(
      codeOf(() => CronSchedule.parse('0 3 * * *', 'Mars/Olympus', now)),
    ).toBe('invalid_timezone');
    expect(codeOf(() => CronSchedule.parse('0 3 * * *', '+02:00', now))).toBe(
      'invalid_timezone',
    );
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Europe/Kyiv')).toBe(true);
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Etc/GMT+5')).toBe(true);
  });
});

describe('CronSchedule DST (D4)', () => {
  it('does not fire a local time the spring-forward skips', () => {
    // Kyiv moves 03:00 → 04:00 on 2026-03-29.
    const schedule = CronSchedule.parse('30 3 * * *', 'Europe/Kyiv');
    expect(iso(schedule.take(at('2026-03-28T00:00:00Z'), 3))).toEqual([
      '2026-03-28T01:30:00.000Z',
      '2026-03-30T00:30:00.000Z',
      '2026-03-31T00:30:00.000Z',
    ]);
  });

  it('fires a local time the fall-back repeats once', () => {
    // Kyiv moves 04:00 → 03:00 on 2026-10-25; 03:30 happens twice.
    const schedule = CronSchedule.parse('30 * * * *', 'Europe/Kyiv');
    expect(iso(schedule.take(at('2026-10-24T23:00:00Z'), 3))).toEqual([
      '2026-10-24T23:30:00.000Z', // 02:30 EEST
      '2026-10-25T00:30:00.000Z', // 03:30 EEST
      '2026-10-25T02:30:00.000Z', // 04:30 EET — the second 03:30 is dropped
    ]);
    const daily = CronSchedule.parse('30 3 * * *', 'Europe/Kyiv');
    expect(iso(daily.take(at('2026-10-24T12:00:00Z'), 2))).toEqual([
      '2026-10-25T00:30:00.000Z',
      '2026-10-26T01:30:00.000Z',
    ]);
  });

  it('walks backwards with the same rules', () => {
    const schedule = CronSchedule.parse('30 3 * * *', 'Europe/Kyiv');
    expect(schedule.atOrBefore(at('2026-03-29T12:00:00Z'))).toEqual(
      at('2026-03-28T01:30:00Z'),
    );
    expect(schedule.atOrBefore(at('2026-03-28T01:30:00Z'))).toEqual(
      at('2026-03-28T01:30:00Z'),
    );
  });

  it('counts firings in a closed range', () => {
    const schedule = CronSchedule.parse('0 * * * *', 'UTC');
    expect(
      schedule.countBetween(
        at('2026-10-09T10:00:00Z'),
        at('2026-10-09T13:00:00Z'),
        100,
      ),
    ).toBe(4);
    expect(
      schedule.countBetween(
        at('2026-10-09T10:00:00Z'),
        at('2026-10-09T13:00:00Z'),
        2,
      ),
    ).toBe(2);
  });
});

describe('planClaim (D6)', () => {
  const hourly = CronSchedule.parse('0 * * * *', 'UTC');
  const due = at('2026-10-09T10:00:00Z');

  it('fires an on-time occurrence as cron and moves to the next', () => {
    const plan = planClaim({
      schedule: hourly,
      due,
      now: at('2026-10-09T10:00:15Z'),
      policy: 'skip',
    });
    expect(plan.fire).toEqual({ scheduledFor: due, kind: 'cron' });
    expect(plan.skipped).toBeNull();
    expect(plan.nextRunAt).toEqual(at('2026-10-09T11:00:00Z'));
  });

  it('skip: three missed occurrences are one skipped row, nothing fired', () => {
    const plan = planClaim({
      schedule: hourly,
      due,
      now: at('2026-10-09T12:30:00Z'),
      policy: 'skip',
    });
    expect(plan.fire).toBeNull();
    expect(plan.skipped).toEqual({
      scheduledFor: due,
      missedCount: 3,
      reason: 'missed',
    });
    expect(plan.nextRunAt).toEqual(at('2026-10-09T13:00:00Z'));
  });

  it('catch_up: fires the newest once, the older two are one skipped row', () => {
    const plan = planClaim({
      schedule: hourly,
      due,
      now: at('2026-10-09T12:30:00Z'),
      policy: 'catch_up',
    });
    expect(plan.fire).toEqual({
      scheduledFor: at('2026-10-09T12:00:00Z'),
      kind: 'catch_up',
    });
    expect(plan.skipped).toEqual({
      scheduledFor: due,
      missedCount: 2,
      reason: 'missed',
    });
  });

  it('catch_up: a newest occurrence older than 24 hours is skipped only', () => {
    const weekly = CronSchedule.parse('0 0 * * 1', 'UTC');
    const monday = at('2026-10-05T00:00:00Z');
    const plan = planClaim({
      schedule: weekly,
      due: monday,
      now: at('2026-10-07T00:00:00Z'),
      policy: 'catch_up',
    });
    expect(plan.fire).toBeNull();
    expect(plan.skipped).toEqual({
      scheduledFor: monday,
      missedCount: 1,
      reason: 'missed_over_24h',
    });
    expect(plan.nextRunAt).toEqual(at('2026-10-12T00:00:00Z'));
  });

  it('a late claim whose newest occurrence is on time fires it as cron', () => {
    const plan = planClaim({
      schedule: hourly,
      due,
      now: at('2026-10-09T11:00:30Z'),
      policy: 'skip',
    });
    expect(plan.fire).toEqual({
      scheduledFor: at('2026-10-09T11:00:00Z'),
      kind: 'cron',
    });
    expect(plan.skipped).toEqual({
      scheduledFor: due,
      missedCount: 1,
      reason: 'missed',
    });
  });

  it('D9 retry: the recorded occurrence fires as catch_up and is not counted', () => {
    const plan = planClaim({
      schedule: hourly,
      due,
      now: at('2026-10-09T10:20:00Z'),
      policy: 'catch_up',
      dueRecorded: true,
    });
    expect(plan.fire).toEqual({ scheduledFor: due, kind: 'catch_up' });
    expect(plan.skipped).toBeNull();

    const later = planClaim({
      schedule: hourly,
      due,
      now: at('2026-10-09T12:20:00Z'),
      policy: 'catch_up',
      dueRecorded: true,
    });
    expect(later.fire).toEqual({
      scheduledFor: at('2026-10-09T12:00:00Z'),
      kind: 'catch_up',
    });
    expect(later.skipped).toEqual({
      scheduledFor: at('2026-10-09T11:00:00Z'),
      missedCount: 1,
      reason: 'missed',
    });
  });

  it('D9 retry past 24 hours: skipped, the recorded occurrence not counted', () => {
    const daily = CronSchedule.parse('0 3 * * *', 'UTC');
    const plan = planClaim({
      schedule: daily,
      due: at('2026-10-01T03:00:00Z'),
      now: at('2026-10-01T03:00:00Z'),
      policy: 'catch_up',
      dueRecorded: true,
    });
    expect(plan.fire).toEqual({
      scheduledFor: at('2026-10-01T03:00:00Z'),
      kind: 'catch_up',
    });
    const stale = planClaim({
      schedule: CronSchedule.parse('0 3 * * 1', 'UTC'),
      due: at('2026-10-05T03:00:00Z'),
      now: at('2026-10-07T03:00:00Z'),
      policy: 'catch_up',
      dueRecorded: true,
    });
    expect(stale.fire).toBeNull();
    expect(stale.skipped).toBeNull();
    expect(stale.nextRunAt).toEqual(at('2026-10-12T03:00:00Z'));
  });
});
