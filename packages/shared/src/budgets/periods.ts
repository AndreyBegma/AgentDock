import {
  BUDGET_DEFAULT_THRESHOLDS,
  BUDGET_MAX_THRESHOLDS,
  type BudgetPeriod,
  type BudgetState,
} from './contracts';

/** `[start, end)` as UTC instants (D9). */
export interface PeriodRange {
  start: Date;
  end: Date;
}

interface LocalDate {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
}

const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterOf = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
};

/** Whether `timeZone` is an IANA zone this runtime knows. */
export const isValidTimeZone = (timeZone: string): boolean => {
  if (timeZone.trim() === '') return false;
  try {
    formatterOf(timeZone);
    return true;
  } catch {
    return false;
  }
};

/** The wall-clock fields of `instant` in `timeZone`. */
const wallClock = (instant: number, timeZone: string) => {
  const parts: Record<string, number> = {};
  for (const p of formatterOf(timeZone).formatToParts(new Date(instant))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
};

/** Local time minus UTC at `instant`, in ms. */
const offsetAt = (instant: number, timeZone: string): number => {
  const w = wallClock(instant, timeZone);
  const asUtc = Date.UTC(
    w.year,
    w.month - 1,
    w.day,
    w.hour,
    w.minute,
    w.second,
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
};

/**
 * The first instant of local date `d` in `timeZone`. Two passes settle the
 * offset across a DST change; where midnight itself does not exist (a zone
 * that springs forward at 00:00) the result is the first instant of that day.
 */
const startOfLocalDay = (d: LocalDate, timeZone: string): number => {
  const wall = Date.UTC(d.year, d.month - 1, d.day);
  let instant = wall - offsetAt(wall, timeZone);
  instant = wall - offsetAt(instant, timeZone);
  const w = wallClock(instant, timeZone);
  if (w.day !== d.day) {
    // Midnight was skipped: walk forward to the day's first instant.
    instant += (24 - w.hour) * 3_600_000 - w.minute * 60_000;
  }
  return instant;
};

/** `d` plus `days`, on the calendar. */
const addDays = (d: LocalDate, days: number): LocalDate => {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day) + days * DAY_MS);
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
  };
};

/** 0 = Monday … 6 = Sunday. */
const weekdayOf = (d: LocalDate): number =>
  (new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() + 6) % 7;

/**
 * The period of kind `period` that contains `at`, cut in `timeZone` (D1, D9):
 * local midnight to local midnight, weeks from Monday, months from the 1st.
 */
export const periodAt = (
  period: BudgetPeriod,
  timeZone: string,
  at: Date,
): PeriodRange => {
  const w = wallClock(at.getTime(), timeZone);
  const today: LocalDate = { year: w.year, month: w.month, day: w.day };
  let first: LocalDate;
  let next: LocalDate;
  switch (period) {
    case 'day':
      first = today;
      next = addDays(today, 1);
      break;
    case 'week':
      first = addDays(today, -weekdayOf(today));
      next = addDays(first, 7);
      break;
    case 'month':
      first = { year: today.year, month: today.month, day: 1 };
      next =
        today.month === 12
          ? { year: today.year + 1, month: 1, day: 1 }
          : { year: today.year, month: today.month + 1, day: 1 };
      break;
  }
  return {
    start: new Date(startOfLocalDay(first, timeZone)),
    end: new Date(startOfLocalDay(next, timeZone)),
  };
};

/**
 * D1: whole percents 1–100, sorted, without duplicates, 100 always present.
 * Null when the list is not acceptable.
 */
export const normalizeThresholds = (
  thresholds: readonly number[] | undefined,
): number[] | null => {
  const list = thresholds ?? BUDGET_DEFAULT_THRESHOLDS;
  if (list.some((t) => !Number.isInteger(t) || t < 1 || t > 100)) return null;
  const sorted = [...new Set([...list, 100])].sort((a, b) => a - b);
  return sorted.length > BUDGET_MAX_THRESHOLDS ? null : sorted;
};

/** The state of a period from what has fired and whether an override is on. */
export const budgetState = (
  firedThresholds: readonly number[],
  overrideActive: boolean,
): BudgetState => {
  if (firedThresholds.includes(100)) {
    return overrideActive ? 'overridden' : 'exceeded';
  }
  return firedThresholds.length > 0 ? 'warning' : 'ok';
};
