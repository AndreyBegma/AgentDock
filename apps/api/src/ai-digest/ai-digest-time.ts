import { AI_DIGEST_DEFAULTS, AI_DIGEST_TIME_PATTERN } from '@nautelle/shared';

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatter = (timeZone: string): Intl.DateTimeFormat => {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, found);
  }
  return found;
};

/** The wall-clock reading of `at` in `timeZone`. */
const partsIn = (at: Date, timeZone: string): Parts => {
  const out: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(at)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute,
    second: out.second,
  };
};

/** How far `timeZone` is ahead of UTC at `at`, in ms. */
const offsetAt = (at: Date, timeZone: string): number => {
  const p = partsIn(at, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(at.getTime() / 1000) * 1000;
};

/** A zone this runtime does not know reads as UTC rather than never sending. */
const knownZone = (timeZone: string): string => {
  try {
    formatter(timeZone);
    return timeZone;
  } catch {
    return AI_DIGEST_DEFAULTS.timezone;
  }
};

/**
 * Today's occurrence of a daily digest (#658): `time` (`HH:MM`) on `now`'s
 * calendar day in `timeZone`, as an instant. A malformed time is the default
 * 09:00. A time a DST jump skips lands after the jump; a time it repeats
 * is read once.
 */
export const zonedDueAt = (now: Date, time: string, timeZone: string): Date => {
  const zone = knownZone(timeZone);
  const match = AI_DIGEST_TIME_PATTERN.exec(time);
  const [hours, minutes] = match
    ? [Number(match[1]), Number(match[2])]
    : AI_DIGEST_DEFAULTS.time.split(':').map(Number);
  const today = partsIn(now, zone);
  const wall = Date.UTC(today.year, today.month - 1, today.day, hours, minutes);
  // The offset at the guess, then at the result: two readings settle DST.
  let due = wall - offsetAt(new Date(wall), zone);
  const settled = wall - offsetAt(new Date(due), zone);
  if (settled !== due) due = Math.max(due, settled);
  return new Date(due);
};
