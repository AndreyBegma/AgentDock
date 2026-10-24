import { zonedDueAt } from './ai-digest-time';

describe('zonedDueAt', () => {
  it('reads the time in UTC', () => {
    expect(
      zonedDueAt(new Date('2026-10-19T15:00:00Z'), '09:00', 'UTC'),
    ).toEqual(new Date('2026-10-19T09:00:00Z'));
  });

  it('reads the time in the project’s zone, on that zone’s calendar day', () => {
    // 23:30 UTC on the 19th is already the 20th in Kyiv (UTC+3 in October).
    expect(
      zonedDueAt(new Date('2026-10-19T23:30:00Z'), '09:00', 'Europe/Kyiv'),
    ).toEqual(new Date('2026-10-20T06:00:00Z'));
    expect(
      zonedDueAt(
        new Date('2026-10-19T12:00:00Z'),
        '07:15',
        'America/Los_Angeles',
      ),
    ).toEqual(new Date('2026-10-19T14:15:00Z'));
  });

  it('follows daylight saving time', () => {
    // Kyiv is UTC+2 after the last Sunday of October.
    expect(
      zonedDueAt(new Date('2026-11-02T12:00:00Z'), '09:00', 'Europe/Kyiv'),
    ).toEqual(new Date('2026-11-02T07:00:00Z'));
    // 02:30 does not exist in New York on 2026-03-08; it lands an hour on.
    const skipped = zonedDueAt(
      new Date('2026-03-08T18:00:00Z'),
      '02:30',
      'America/New_York',
    );
    expect(skipped).toEqual(new Date('2026-03-08T07:30:00Z'));
  });

  it('reads an early time on the day daylight saving time ends', () => {
    // Kyiv leaves summer time at 01:00 UTC on 2026-10-25; 01:12 that morning
    // is still UTC+3, which is 22:12 UTC the evening before.
    expect(
      zonedDueAt(new Date('2026-10-25T00:30:00Z'), '01:12', 'Europe/Kyiv'),
    ).toEqual(new Date('2026-10-24T22:12:00Z'));
  });

  it('falls back to 09:00 and UTC for values it cannot read', () => {
    expect(
      zonedDueAt(new Date('2026-10-19T15:00:00Z'), 'nine', 'Mars/Olympus'),
    ).toEqual(new Date('2026-10-19T09:00:00Z'));
  });
});
