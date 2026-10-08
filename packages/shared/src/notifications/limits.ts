/**
 * The timings of notification matching and delivery
 * (docs/specs/22-notifications-and-telegram.md D4–D6).
 */

const MINUTE_MS = 60_000;

/** D6: the same `(user, kind, project, slot)` within this of `firstAt` folds. */
export const NOTIFICATION_FOLD_WINDOW_MS = 15 * MINUTE_MS;

/** D6: Telegram messages per user per window before the rest are digested. */
export const TELEGRAM_RATE_LIMIT = 20;
export const TELEGRAM_RATE_WINDOW_MS = 10 * MINUTE_MS;

/** D1: at most one `queue.dry` per project in this long. */
export const QUEUE_DRY_INTERVAL_MS = 6 * 60 * MINUTE_MS;

/** D5: a runner away this long opens an incident. */
export const RUNNER_OFFLINE_AFTER_MS = 5 * MINUTE_MS;
