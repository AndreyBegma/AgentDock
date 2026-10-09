import {
  SCHEDULE_CRON_MAX_LENGTH,
  SCHEDULE_INTERVAL_CHECK_COUNT,
  SCHEDULE_MIN_INTERVAL_MS,
  SCHEDULES_ERROR,
  type SchedulesErrorCode,
} from '@agentdock/shared';
import { type CronExpression, CronExpressionParser } from 'cron-parser';

/** D2: the macros a schedule may use; any other `@…` is refused. */
const MACROS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
};

/** An IANA name (`Area/Location[/Sub]`, or `UTC`), never an offset like `+02:00`. */
const IANA_NAME = /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+)$/;

/** How far one search walks before it gives up — an expression like `0 0 31 2 *` never fires. */
const MAX_STEPS = 2000;

const SUPPORTED_ZONES = new Set(Intl.supportedValuesOf('timeZone'));

/**
 * D4. `Intl.supportedValuesOf` lists canonical names only — on Node it lacks
 * `UTC` and has `Europe/Kiev` but not `Europe/Kyiv` — so a name it does not
 * list is still taken when it has the IANA shape and the runtime resolves it.
 */
export const isValidTimezone = (timezone: string): boolean => {
  if (SUPPORTED_ZONES.has(timezone)) return true;
  if (!IANA_NAME.test(timezone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
};

export class CronError extends Error {
  constructor(
    readonly code: SchedulesErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface WallClock {
  key: string;
  hour: number;
  minute: number;
}

/**
 * A cron expression in a timezone (D2–D4), with the DST rules of D4 on top of
 * `cron-parser`: a local time a spring-forward skips does not fire that day
 * (the library would move it to the next hour), and a local time a fall-back
 * repeats fires once (the first time).
 */
export class CronSchedule {
  private readonly hours: ReadonlySet<number>;
  private readonly minutes: ReadonlySet<number>;
  private readonly wall: Intl.DateTimeFormat;

  private constructor(
    readonly expression: string,
    readonly timezone: string,
  ) {
    const fields = this.parse(new Date()).fields;
    this.hours = new Set(fields.hour.values.map(Number));
    this.minutes = new Set(fields.minute.values.map(Number));
    this.wall = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /**
   * Parses and validates `cron` in `timezone`: five fields or one of the D2
   * macros, a valid IANA zone, and no two of the next ten firings closer than
   * the D3 minimum. Throws `CronError` with the API's error code.
   */
  static parse(cron: string, timezone: string, now = new Date()): CronSchedule {
    if (!isValidTimezone(timezone)) {
      throw new CronError(
        SCHEDULES_ERROR.invalidTimezone,
        `${timezone} is not an IANA timezone`,
      );
    }
    const expression = CronSchedule.normalize(cron);
    let schedule: CronSchedule;
    try {
      schedule = new CronSchedule(expression, timezone);
    } catch (error) {
      throw new CronError(
        SCHEDULES_ERROR.invalidCron,
        `Invalid cron expression: ${(error as Error).message}`,
      );
    }
    const next = schedule.take(now, SCHEDULE_INTERVAL_CHECK_COUNT);
    if (next.length === 0) {
      throw new CronError(
        SCHEDULES_ERROR.invalidCron,
        'The cron expression never fires',
      );
    }
    for (let i = 1; i < next.length; i++) {
      if (next[i].getTime() - next[i - 1].getTime() < SCHEDULE_MIN_INTERVAL_MS) {
        throw new CronError(
          SCHEDULES_ERROR.intervalTooShort,
          `Firings must be at least ${SCHEDULE_MIN_INTERVAL_MS / 60_000} minutes apart`,
        );
      }
    }
    return schedule;
  }

  /** Five fields, or a D2 macro expanded; seconds (six fields) are refused. */
  private static normalize(cron: string): string {
    const trimmed = cron.trim();
    if (trimmed.length === 0 || trimmed.length > SCHEDULE_CRON_MAX_LENGTH) {
      throw new CronError(
        SCHEDULES_ERROR.invalidCron,
        `A cron expression is 1 to ${SCHEDULE_CRON_MAX_LENGTH} characters`,
      );
    }
    if (trimmed.startsWith('@')) {
      const macro = MACROS[trimmed.toLowerCase()];
      if (!macro) {
        throw new CronError(
          SCHEDULES_ERROR.invalidCron,
          `Only ${Object.keys(MACROS).join(', ')} are accepted as macros`,
        );
      }
      return macro;
    }
    const fields = trimmed.split(/\s+/);
    if (fields.length !== 5) {
      throw new CronError(
        SCHEDULES_ERROR.invalidCron,
        'A cron expression has five fields: minute hour day-of-month month day-of-week',
      );
    }
    return fields.join(' ');
  }

  /** The first firing strictly after `from`, or null if there is none. */
  after(from: Date): Date | null {
    return this.take(from, 1)[0] ?? null;
  }

  /** Up to `count` firings strictly after `from`, in order. */
  take(from: Date, count: number): Date[] {
    const out: Date[] = [];
    const iterator = this.parse(from);
    for (let step = 0; step < MAX_STEPS && out.length < count; step++) {
      if (!iterator.hasNext()) break;
      const at = iterator.next().toDate();
      if (this.fires(at)) out.push(at);
    }
    return out;
  }

  /** The last firing at or before `at`, or null if there is none. */
  atOrBefore(at: Date): Date | null {
    const iterator = this.parse(new Date(at.getTime() + 1));
    for (let step = 0; step < MAX_STEPS; step++) {
      if (!iterator.hasPrev()) return null;
      const candidate = iterator.prev().toDate();
      if (this.fires(candidate)) return candidate;
    }
    return null;
  }

  /** Firings in `[from, to]`, both ends included, counted up to `cap`. */
  countBetween(from: Date, to: Date, cap: number): number {
    if (from > to) return 0;
    let count = 0;
    let cursor = new Date(from.getTime() - 1);
    while (count < cap) {
      const next = this.after(cursor);
      if (!next || next > to) break;
      count++;
      cursor = next;
    }
    return count;
  }

  private parse(currentDate: Date): CronExpression {
    return CronExpressionParser.parse(this.expression, {
      tz: this.timezone,
      currentDate,
    });
  }

  /** D4: a candidate the library produced is a real, first-time local firing. */
  private fires(at: Date): boolean {
    const local = this.wallClock(at);
    // Spring-forward: the library moved a skipped local time to a later hour.
    if (!this.hours.has(local.hour) || !this.minutes.has(local.minute)) {
      return false;
    }
    // Fall-back: the same local time happened `delta` earlier, at the old offset.
    const delta = this.offsetMs(new Date(at.getTime() - 3 * 3_600_000)) -
      this.offsetMs(at);
    if (delta > 0) {
      const earlier = this.wallClock(new Date(at.getTime() - delta));
      if (earlier.key === local.key) return false;
    }
    return true;
  }

  private wallClock(at: Date): WallClock {
    const parts = Object.fromEntries(
      this.wall.formatToParts(at).map((p) => [p.type, p.value]),
    );
    return {
      key: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`,
      hour: Number(parts.hour),
      minute: Number(parts.minute),
    };
  }

  /** The zone's UTC offset at `at`, in ms. */
  private offsetMs(at: Date): number {
    const parts = Object.fromEntries(
      this.wall.formatToParts(at).map((p) => [p.type, p.value]),
    );
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
    );
    const minuteFloor = at.getTime() - (at.getTime() % 60_000);
    return asUtc - minuteFloor;
  }
}
