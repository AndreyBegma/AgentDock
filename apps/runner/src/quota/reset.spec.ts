import { describe, expect, it } from 'bun:test';
import { parseResetsAt } from './reset';

// Wed 2026-10-21 12:00 UTC.
const now = new Date('2026-10-21T12:00:00Z');
const parse = (text: string, zone = 'UTC') =>
  parseResetsAt(text, { now, zone });

describe('parseResetsAt', () => {
  it('reads a weekday and a time with minutes', () => {
    expect(parse('resets Mon 9:00am')).toBe('2026-10-26T09:00:00.000Z');
  });

  it('reads a bare hour as the next such hour', () => {
    expect(parse('resets 2pm')).toBe('2026-10-21T14:00:00.000Z');
    expect(parse('resets 9am')).toBe('2026-10-22T09:00:00.000Z');
  });

  it('reads 12am and 12pm', () => {
    expect(parse('resets 12am')).toBe('2026-10-22T00:00:00.000Z');
    expect(parse('resets 12pm')).toBe('2026-10-22T12:00:00.000Z');
  });

  it('takes the same weekday a week on once today has passed', () => {
    expect(parse('resets Wed 9am')).toBe('2026-10-28T09:00:00.000Z');
  });

  it('reads a relative time', () => {
    expect(parse('resets in 3 hours')).toBe('2026-10-21T15:00:00.000Z');
    expect(parse('resets in 45 minutes')).toBe('2026-10-21T12:45:00.000Z');
  });

  it('reads the zone the banner names, over the default one', () => {
    // Kyiv is UTC+3 in October 2026 (EEST until the 25th).
    expect(parse('resets 4pm (Europe/Kyiv)')).toBe('2026-10-21T13:00:00.000Z');
    expect(parse('resets 2pm (Europe/Kyiv)')).toBe('2026-10-22T11:00:00.000Z');
  });

  it('reads a banner without a zone in the one given', () => {
    expect(parse('resets 4pm', 'Europe/Kyiv')).toBe('2026-10-21T13:00:00.000Z');
  });

  it('follows a DST change between now and the reset', () => {
    // EEST ends 2026-10-25, so Mon 9am in Kyiv is UTC+2.
    expect(parse('resets Mon 9:00am (Europe/Kyiv)')).toBe(
      '2026-10-26T07:00:00.000Z',
    );
  });

  it('is null for text it cannot read', () => {
    expect(parse('')).toBeNull();
    expect(parse('resets soon')).toBeNull();
    expect(parse('resets 13pm')).toBeNull();
    expect(parse('resets 9:75am')).toBeNull();
    expect(parse('resets 2pm (Not/AZone)')).toBeNull();
  });
});
