const DIGEST_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The digest time a project falls back to when its stored value is not `HH:MM`. */
const FALLBACK = { hours: 9, minutes: 0 };

/**
 * When today's daily digest is due: `digestTime` (`HH:MM`) on `now`'s calendar
 * day in the server's timezone (D14 — the schema holds no timezone per
 * person, so the server's is the one that applies). A malformed value is
 * treated as the default 09:00 rather than never sending.
 */
export const dailyDueAt = (now: Date, digestTime: string): Date => {
  const match = DIGEST_TIME.exec(digestTime);
  const hours = match ? Number(match[1]) : FALLBACK.hours;
  const minutes = match ? Number(match[2]) : FALLBACK.minutes;
  const due = new Date(now);
  due.setHours(hours, minutes, 0, 0);
  return due;
};

/** Whether the daily digest has come due and none was made since. */
export const dailyIsDue = (
  now: Date,
  digestTime: string,
  lastDailyAt: Date | null,
): boolean => {
  const due = dailyDueAt(now, digestTime);
  if (now < due) return false;
  return lastDailyAt === null || lastDailyAt < due;
};
