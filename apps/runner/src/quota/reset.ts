const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** `resets in 3 hours`, `resets in 45 minutes`. */
const RELATIVE = /resets?\s+in\s+(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i;
/** `resets Mon 9:00am`, `resets 2pm`, with an optional `(Europe/Kyiv)`. */
const ABSOLUTE =
  /resets?\s+(?:at\s+)?(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)*)\))?/i;

export interface ResetOptions {
  /** The instant the banner was read. */
  now: Date;
  /** The zone a banner without one is read in. Defaults to the runner's. */
  zone?: string;
}

const localZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const formatterFor = (zone: string): Intl.DateTimeFormat | null => {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
  } catch {
    return null;
  }
};

interface Wall {
  year: number;
  month: number;
  day: number;
  weekday: number;
}

/** The wall-clock date `instant` has in the formatter's zone. */
const wallOf = (format: Intl.DateTimeFormat, instant: number): Wall => {
  const parts = new Map(
    format.formatToParts(new Date(instant)).map((p) => [p.type, p.value]),
  );
  const weekday = WEEKDAYS.indexOf(
    (parts.get('weekday') ?? '').slice(0, 3).toLowerCase() as never,
  );
  return {
    year: Number(parts.get('year')),
    month: Number(parts.get('month')),
    day: Number(parts.get('day')),
    weekday,
  };
};

/** The zone's offset from UTC, in ms, at `instant`. */
const offsetAt = (format: Intl.DateTimeFormat, instant: number): number => {
  const parts = new Map(
    format.formatToParts(new Date(instant)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.get('year')),
    Number(parts.get('month')) - 1,
    Number(parts.get('day')),
    Number(parts.get('hour')),
    Number(parts.get('minute')),
    Number(parts.get('second')),
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
};

/** The instant at which the zone's wall clock reads the given date and time. */
const zonedInstant = (
  format: Intl.DateTimeFormat,
  date: { year: number; month: number; day: number },
  hour: number,
  minute: number,
): number => {
  const guess = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  // The offset at the guess may differ from the one at the answer across a
  // DST change; a second pass settles it.
  const first = guess - offsetAt(format, guess);
  return guess - offsetAt(format, first);
};

const hour24 = (hour: number, meridiem: string): number | null => {
  if (hour < 1 || hour > 12) return null;
  const pm = meridiem.toLowerCase() === 'pm';
  return (hour % 12) + (pm ? 12 : 0);
};

/**
 * When the limit on a banner resets (spec 741 D2): the text after a `resets`
 * word, as an ISO-8601 UTC string. An absolute time is the next instant after
 * `now` that matches, in the zone the banner names or else `zone`. Text that
 * does not parse gives null — the session is then never resumed.
 */
export const parseResetsAt = (
  text: string,
  options: ResetOptions,
): string | null => {
  const nowMs = options.now.getTime();
  const relative = RELATIVE.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = (relative[2] ?? '').toLowerCase();
    const ms = unit.startsWith('h') ? amount * 3_600_000 : amount * 60_000;
    return new Date(nowMs + ms).toISOString();
  }

  const absolute = ABSOLUTE.exec(text);
  if (!absolute) return null;
  const hour = hour24(Number(absolute[2]), absolute[4] ?? '');
  const minute = Number(absolute[3] ?? 0);
  if (hour === null || minute > 59) return null;
  const weekday = absolute[1]
    ? WEEKDAYS.indexOf(absolute[1].toLowerCase() as never)
    : null;

  const format =
    formatterFor(absolute[5] ?? options.zone ?? localZone()) ??
    (absolute[5] ? null : formatterFor('UTC'));
  if (!format) return null;

  const today = wallOf(format, nowMs);
  for (let ahead = 0; ahead <= 7; ahead += 1) {
    // Date.UTC normalises a day past the month's end.
    const day = new Date(
      Date.UTC(today.year, today.month - 1, today.day + ahead),
    );
    if (weekday !== null && (today.weekday + ahead) % 7 !== weekday) continue;
    const instant = zonedInstant(
      format,
      {
        year: day.getUTCFullYear(),
        month: day.getUTCMonth() + 1,
        day: day.getUTCDate(),
      },
      hour,
      minute,
    );
    if (instant > nowMs) return new Date(instant).toISOString();
  }
  return null;
};
