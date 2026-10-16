import { dailyDueAt, dailyIsDue } from './steward-digest-time';

/** A local-time instant: the helpers work in the server's timezone. */
const at = (h: number, m = 0) => new Date(2026, 9, 16, h, m, 0, 0);

describe('daily digest time (D14)', () => {
  it('is due at digestTime on the same calendar day', () => {
    expect(dailyDueAt(at(14, 30), '09:00')).toEqual(at(9));
    expect(dailyDueAt(at(3), '21:45')).toEqual(at(21, 45));
  });

  it('treats a malformed time as the default 09:00', () => {
    expect(dailyDueAt(at(12), '25:99')).toEqual(at(9));
    expect(dailyDueAt(at(12), 'noon')).toEqual(at(9));
  });

  it('is not due before the time', () => {
    expect(dailyIsDue(at(8, 59), '09:00', null)).toBe(false);
  });

  it('is due from the time on when none was made', () => {
    expect(dailyIsDue(at(9), '09:00', null)).toBe(true);
    expect(dailyIsDue(at(17), '09:00', null)).toBe(true);
  });

  it('is not due again once one was made since the time', () => {
    expect(dailyIsDue(at(9, 5), '09:00', at(9, 0))).toBe(false);
    expect(dailyIsDue(at(23), '09:00', at(9, 1))).toBe(false);
  });

  it("is due again when the last one is yesterday's", () => {
    const yesterday = new Date(2026, 9, 15, 9, 0, 0, 0);
    expect(dailyIsDue(at(9, 1), '09:00', yesterday)).toBe(true);
  });

  it('a digest made before a later digestTime does not cover it', () => {
    // The time moved from 09:00 to 18:00 after the 09:00 digest was made.
    expect(dailyIsDue(at(18, 1), '18:00', at(9, 0))).toBe(true);
  });
});
