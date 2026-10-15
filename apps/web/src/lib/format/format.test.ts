import { describe, expect, test } from 'bun:test';
import {
  formatAbsolute,
  formatCost,
  formatDate,
  formatDuration,
  formatNumber,
  formatRelative,
  formatTokens,
  pluralize,
} from './index';

const NOW = new Date(2026, 9, 13, 12, 0, 0).getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatRelative', () => {
  test('steps from just now to days', () => {
    expect(formatRelative(ago(30_000), NOW)).toBe('just now');
    expect(formatRelative(ago(5 * MIN), NOW)).toBe('5 min ago');
    expect(formatRelative(ago(3 * HOUR + 59 * MIN), NOW)).toBe('3 h ago');
    expect(formatRelative(ago(30 * HOUR), NOW)).toBe('yesterday');
    expect(formatRelative(ago(4 * DAY), NOW)).toBe('4 d ago');
  });

  test('a week or more is the date, with the year only when it differs', () => {
    expect(formatRelative(ago(10 * DAY), NOW)).toBe('Oct 3');
    expect(formatRelative(new Date(2025, 11, 30).toISOString(), NOW)).toBe(
      'Dec 30, 2025',
    );
  });

  test('a future time reads forwards', () => {
    expect(formatRelative(ago(-10 * MIN), NOW)).toBe('in 10 min');
    expect(formatRelative(ago(-20_000), NOW)).toBe('in a moment');
  });

  test('nothing or garbage is blank', () => {
    expect(formatRelative(null, NOW)).toBe('');
    expect(formatRelative('not a date', NOW)).toBe('');
    expect(formatRelative('', NOW)).toBe('');
  });
});

describe('formatDate', () => {
  const at = new Date(2026, 9, 3, 14, 5, 9);
  test('fixed styles in one locale, 24-hour', () => {
    expect(formatDate(at, 'date')).toBe('Oct 3, 2026');
    expect(formatDate(at, 'day')).toBe('Oct 3');
    expect(formatDate(at, 'datetime')).toBe('Oct 3, 2026, 14:05');
    expect(formatDate(at, 'time')).toBe('14:05:09');
  });

  test('accepts ISO strings and epoch numbers', () => {
    expect(formatDate(at.toISOString(), 'date')).toBe('Oct 3, 2026');
    expect(formatDate(at.getTime(), 'date')).toBe('Oct 3, 2026');
  });

  test('blank for nothing', () => {
    expect(formatDate(undefined)).toBe('');
    expect(formatDate('garbage')).toBe('');
  });
});

describe('formatAbsolute', () => {
  test('carries seconds and the year', () => {
    const text = formatAbsolute(new Date(2026, 9, 3, 14, 5, 9));
    expect(text).toContain('Oct 3, 2026');
    expect(text).toContain('2:05:09');
  });
  test('blank for nothing', () => {
    expect(formatAbsolute(null)).toBe('');
  });
});

describe('formatDuration', () => {
  test('picks the unit that reads best', () => {
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(1_000)).toBe('1 s');
    expect(formatDuration(12_400)).toBe('12 s');
    expect(formatDuration(4_250)).toBe('4.3 s');
    expect(formatDuration(3 * MIN + 5_000)).toBe('3 min 05 s');
    expect(formatDuration(2 * HOUR + 7 * MIN)).toBe('2 h 07 min');
  });
  test('blank for nothing, negatives and NaN', () => {
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(-1)).toBe('');
    expect(formatDuration(Number.NaN)).toBe('');
  });
});

describe('formatNumber', () => {
  test('groups in the app locale', () => {
    expect(formatNumber(12345)).toBe('12,345');
    expect(formatNumber('1234.567')).toBe('1,234.57');
    expect(formatNumber(1234.567, 0)).toBe('1,235');
    expect(formatNumber(0)).toBe('0');
  });
  test('blank for nothing', () => {
    expect(formatNumber(null)).toBe('');
    expect(formatNumber('abc')).toBe('');
  });
});

describe('formatCost', () => {
  test('dollars with cents', () => {
    expect(formatCost('1234.5')).toBe('$1,234.50');
    expect(formatCost(0.42)).toBe('$0.42');
    expect(formatCost('0')).toBe('$0.00');
  });
  test('a real but tiny cost is not rounded to zero', () => {
    expect(formatCost('0.0004')).toBe('<$0.01');
  });
  test('no price is blank, never $0.00', () => {
    expect(formatCost(null)).toBe('');
    expect(formatCost(undefined)).toBe('');
    expect(formatCost('')).toBe('');
  });
});

describe('formatTokens', () => {
  test('compact units', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_345)).toBe('12.3k');
    expect(formatTokens(250_000)).toBe('250k');
    expect(formatTokens(4_500_000)).toBe('4.5M');
    expect(formatTokens(1_200_000_000)).toBe('1.2B');
  });
  test('blank for nothing', () => {
    expect(formatTokens(null)).toBe('');
  });
});

describe('pluralize', () => {
  test('one and many', () => {
    expect(pluralize(1, 'turn')).toBe('1 turn');
    expect(pluralize(0, 'turn')).toBe('0 turns');
    expect(pluralize(1204, 'turn')).toBe('1,204 turns');
    expect(pluralize(2, 'entry', 'entries')).toBe('2 entries');
  });
});
