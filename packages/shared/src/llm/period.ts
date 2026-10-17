/**
 * A provider's cap is per calendar month in UTC (ADR-0058): spend counts from
 * 00:00 UTC on the 1st and resets at 00:00 UTC on the 1st of the next month.
 */
export const llmMonthStart = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** When the month that holds `now` ends — the next cap reset. */
export const llmNextReset = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
