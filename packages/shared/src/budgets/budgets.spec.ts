import { describe, expect, it } from 'bun:test';
import {
  budgetState,
  isValidTimeZone,
  normalizeThresholds,
  periodAt,
} from './periods';

const iso = (r: { start: Date; end: Date }) => ({
  start: r.start.toISOString(),
  end: r.end.toISOString(),
});

describe('budget periods (spec 28 D1, D9)', () => {
  it('cuts a UTC day', () => {
    expect(
      iso(periodAt('day', 'UTC', new Date('2026-10-09T13:00:00Z'))),
    ).toEqual({
      start: '2026-10-09T00:00:00.000Z',
      end: '2026-10-10T00:00:00.000Z',
    });
  });

  it('cuts a Berlin day at local midnight in summer and winter', () => {
    expect(
      iso(periodAt('day', 'Europe/Berlin', new Date('2026-07-01T23:30:00Z'))),
    ).toEqual({
      start: '2026-07-01T22:00:00.000Z',
      end: '2026-07-02T22:00:00.000Z',
    });
    expect(
      iso(periodAt('day', 'Europe/Berlin', new Date('2026-12-01T22:59:59Z'))),
    ).toEqual({
      start: '2026-11-30T23:00:00.000Z',
      end: '2026-12-01T23:00:00.000Z',
    });
  });

  it('gives the Berlin DST days 23 and 25 hours', () => {
    // 2026-03-29: clocks go 02:00 → 03:00; 2026-10-25: 03:00 → 02:00.
    const spring = periodAt(
      'day',
      'Europe/Berlin',
      new Date('2026-03-29T12:00:00Z'),
    );
    expect(iso(spring)).toEqual({
      start: '2026-03-28T23:00:00.000Z',
      end: '2026-03-29T22:00:00.000Z',
    });
    expect(spring.end.getTime() - spring.start.getTime()).toBe(23 * 3_600_000);
    const autumn = periodAt(
      'day',
      'Europe/Berlin',
      new Date('2026-10-25T12:00:00Z'),
    );
    expect(iso(autumn)).toEqual({
      start: '2026-10-24T22:00:00.000Z',
      end: '2026-10-25T23:00:00.000Z',
    });
  });

  it('starts weeks on Monday', () => {
    // 2026-10-09 is a Friday; 2026-10-11 a Sunday; 2026-10-12 a Monday.
    expect(
      iso(periodAt('week', 'UTC', new Date('2026-10-09T10:00:00Z'))),
    ).toEqual({
      start: '2026-10-05T00:00:00.000Z',
      end: '2026-10-12T00:00:00.000Z',
    });
    expect(
      periodAt('week', 'UTC', new Date('2026-10-11T23:59:59Z')).end,
    ).toEqual(new Date('2026-10-12T00:00:00Z'));
    expect(
      periodAt('week', 'UTC', new Date('2026-10-12T00:00:00Z')).start,
    ).toEqual(new Date('2026-10-12T00:00:00Z'));
  });

  it('cuts months, December included, in a half-hour zone', () => {
    expect(
      iso(periodAt('month', 'Asia/Kolkata', new Date('2026-12-15T00:00:00Z'))),
    ).toEqual({
      start: '2026-11-30T18:30:00.000Z',
      end: '2026-12-31T18:30:00.000Z',
    });
  });

  it('uses the local date, not the UTC one', () => {
    // 23:30 UTC on the 9th is already the 10th in Berlin.
    expect(
      periodAt('day', 'Europe/Berlin', new Date('2026-10-09T23:30:00Z')).start,
    ).toEqual(new Date('2026-10-09T22:00:00Z'));
  });

  it('starts a zone that skips midnight at its first instant', () => {
    // America/Santiago sprang forward 00:00 → 01:00 on 2024-09-08.
    const range = periodAt(
      'day',
      'America/Santiago',
      new Date('2024-09-08T15:00:00Z'),
    );
    expect(range.start.toISOString()).toBe('2024-09-08T04:00:00.000Z');
    expect(range.end.toISOString()).toBe('2024-09-09T03:00:00.000Z');
  });

  it('knows IANA zones', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('budget thresholds (spec 28 D1)', () => {
  it('defaults to 50/80/100', () => {
    expect(normalizeThresholds(undefined)).toEqual([50, 80, 100]);
  });

  it('sorts, dedupes and always keeps 100', () => {
    expect(normalizeThresholds([90, 25, 25])).toEqual([25, 90, 100]);
    expect(normalizeThresholds([])).toEqual([100]);
  });

  it('refuses fractions, out-of-range values and too many', () => {
    expect(normalizeThresholds([50.5])).toBeNull();
    expect(normalizeThresholds([0])).toBeNull();
    expect(normalizeThresholds([101])).toBeNull();
    expect(normalizeThresholds([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBeNull();
  });
});

describe('budget state', () => {
  it('derives ok, warning, exceeded and overridden', () => {
    expect(budgetState([], false)).toBe('ok');
    expect(budgetState([50], false)).toBe('warning');
    expect(budgetState([50, 80, 100], false)).toBe('exceeded');
    expect(budgetState([50, 80, 100], true)).toBe('overridden');
    expect(budgetState([50], true)).toBe('warning');
  });
});
