import {
  TELEGRAM_RATE_LIMIT,
  TELEGRAM_RATE_WINDOW_MS,
} from '@agentdock/shared';

export interface RatePlanInput {
  /** Pending deliveries due now, oldest first. */
  due: string[];
  /** Messages already counted against the window: sent, or claimed and not yet reported. */
  usedInWindow: number;
  /** The oldest `sentAt` inside the window; null when nothing was sent in it. */
  oldestSentAt: Date | null;
  now: Date;
  limit?: number;
  windowMs?: number;
}

export interface RatePlan {
  /** Send one message each, now. */
  send: string[];
  /** Over the limit: folded into one digest sent at `digestAt`. */
  digest: string[];
  /** When the current window ends — the digest's send time. */
  digestAt: Date;
}

/**
 * D6 for one user: at most `limit` messages per sliding `windowMs`. What does
 * not fit waits for one digest message at the end of the current window,
 * instead of trickling out as the window slides.
 */
export const planTelegramDeliveries = ({
  due,
  usedInWindow,
  oldestSentAt,
  now,
  limit = TELEGRAM_RATE_LIMIT,
  windowMs = TELEGRAM_RATE_WINDOW_MS,
}: RatePlanInput): RatePlan => {
  const room = Math.max(0, limit - usedInWindow);
  return {
    send: due.slice(0, room),
    digest: due.slice(room),
    digestAt: new Date((oldestSentAt ?? now).getTime() + windowMs),
  };
};
