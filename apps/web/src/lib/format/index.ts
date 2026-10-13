/**
 * The one place dates and numbers become text (issue #159, R3).
 *
 * One locale for every figure on every screen; the timezone stays the
 * browser's. Every formatter takes what the API sends — an ISO string, a
 * decimal string or a number — and answers `''` for nothing or garbage, so a
 * missing value renders as a blank, never as "Invalid Date" or "NaN".
 */

export const APP_LOCALE = 'en-US';

/** Tabular numerals: digits line up in columns and do not jitter on update. */
export const TABULAR = 'tabular-nums';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type DateInput = string | number | Date | null | undefined;

function toTime(value: DateInput): number | null {
  if (value === null || value === undefined || value === '') return null;
  const time =
    value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

const DATE_STYLES = {
  /** Oct 13, 2026 */
  date: { year: 'numeric', month: 'short', day: 'numeric' },
  /** Oct 13 */
  day: { month: 'short', day: 'numeric' },
  /** Oct 13, 2026, 14:05 */
  datetime: {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  },
  /** 14:05:09 */
  time: {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

export type DateStyle = keyof typeof DATE_STYLES;

const dateFormatters = new Map<DateStyle, Intl.DateTimeFormat>();

function dateFormatter(style: DateStyle): Intl.DateTimeFormat {
  let formatter = dateFormatters.get(style);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(APP_LOCALE, DATE_STYLES[style]);
    dateFormatters.set(style, formatter);
  }
  return formatter;
}

/** A date in one of the app's fixed styles; `''` for a missing or invalid one. */
export function formatDate(
  value: DateInput,
  style: DateStyle = 'datetime',
): string {
  const time = toTime(value);
  return time === null ? '' : dateFormatter(style).format(time);
}

/** The full instant, with seconds and zone — what a tooltip on a relative time says. */
export function formatAbsolute(value: DateInput): string {
  const time = toTime(value);
  if (time === null) return '';
  return new Intl.DateTimeFormat(APP_LOCALE, {
    dateStyle: 'medium',
    timeStyle: 'long',
  }).format(time);
}

/**
 * "just now", "5 min ago", "3 h ago", "yesterday", "4 d ago", then the date.
 * A time in the future (clock skew, a scheduled run) reads "in 5 min".
 */
export function formatRelative(
  value: DateInput,
  now: number = Date.now(),
): string {
  const time = toTime(value);
  if (time === null) return '';
  const delta = now - time;
  const age = Math.abs(delta);
  const phrase = (amount: string) =>
    delta >= 0 ? `${amount} ago` : `in ${amount}`;
  if (age < MINUTE) return delta >= 0 ? 'just now' : 'in a moment';
  if (age < HOUR) return phrase(`${Math.floor(age / MINUTE)} min`);
  if (age < DAY) return phrase(`${Math.floor(age / HOUR)} h`);
  if (age < 2 * DAY) return delta >= 0 ? 'yesterday' : 'tomorrow';
  if (age < 7 * DAY) return phrase(`${Math.floor(age / DAY)} d`);
  const sameYear =
    new Date(time).getFullYear() === new Date(now).getFullYear();
  return formatDate(time, sameYear ? 'day' : 'date');
}

/** A duration in milliseconds: "850 ms", "12.4 s", "3 min 05 s", "2 h 07 min". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return '';
  }
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < MINUTE) {
    const seconds = ms / 1_000;
    return `${seconds < 10 ? seconds.toFixed(1).replace(/\.0$/, '') : Math.floor(seconds)} s`;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  if (ms < HOUR) {
    const minutes = Math.floor(ms / MINUTE);
    const seconds = Math.floor((ms % MINUTE) / 1_000);
    return `${minutes} min ${pad(seconds)} s`;
  }
  const hours = Math.floor(ms / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  return `${hours} h ${pad(minutes)} min`;
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

const integerFormatter = new Intl.NumberFormat(APP_LOCALE);

/** "12,345", "1,234.5" — grouping in the app locale, at most `maxFractionDigits`. */
export function formatNumber(
  value: string | number | null | undefined,
  maxFractionDigits = 2,
): string {
  const n = toNumber(value);
  if (n === null) return '';
  if (maxFractionDigits === 0 || Number.isInteger(n)) {
    return integerFormatter.format(Math.round(n));
  }
  return n.toLocaleString(APP_LOCALE, {
    maximumFractionDigits: maxFractionDigits,
  });
}

const costFormatter = new Intl.NumberFormat(APP_LOCALE, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * US dollars. Blank when there is no price at all — never `$0.00` for an
 * unpriced figure; `<$0.01` for a real but tiny one.
 */
export function formatCost(value: string | number | null | undefined): string {
  const n = toNumber(value);
  if (n === null) return '';
  if (n === 0) return costFormatter.format(0);
  if (Math.abs(n) < 0.01) return '<$0.01';
  return costFormatter.format(n);
}

/** Token counts, compact: "950", "12.3k", "4.5M", "1.2B". */
export function formatTokens(value: number | null | undefined): string {
  const n = toNumber(value);
  if (n === null) return '';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const trim = (v: number) =>
    v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '');
  if (abs < 1_000) return `${sign}${Math.round(abs)}`;
  if (abs < 1_000_000) return `${sign}${trim(abs / 1_000)}k`;
  if (abs < 1_000_000_000) return `${sign}${trim(abs / 1_000_000)}M`;
  return `${sign}${trim(abs / 1_000_000_000)}B`;
}

/** "1 turn", "3 turns", "1,204 turns"; `many` for irregular plurals. */
export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}
