import {
  WEBHOOK_CIRCUIT_THRESHOLD,
  WEBHOOK_MAX_ATTEMPTS,
  type WebhookCircuitState,
  type WebhookDeliveryStatus,
  webhookRetryDelayMs,
} from '@agentdock/shared';

/**
 * The decisions of the delivery worker (docs/specs/26-webhooks.md D12, D14),
 * pure so they are tested without a receiver or a clock.
 */

export interface DeliveryNext {
  status: WebhookDeliveryStatus;
  nextAttemptAt: Date;
}

/**
 * D12: where a delivery goes after an attempt. `attempts` counts the attempt
 * just made. A failure before the 8th is retried at 30 s × 2^(attempts−1)
 * ±20 %; the 8th failure is final.
 */
export const deliveryAfterAttempt = (
  succeeded: boolean,
  attempts: number,
  now: Date,
  random: () => number = Math.random,
): DeliveryNext => {
  if (succeeded) return { status: 'succeeded', nextAttemptAt: now };
  if (attempts >= WEBHOOK_MAX_ATTEMPTS)
    return { status: 'failed', nextAttemptAt: now };
  return {
    status: 'pending',
    nextAttemptAt: new Date(
      now.getTime() + webhookRetryDelayMs(attempts, random),
    ),
  };
};

export interface Circuit {
  circuitState: WebhookCircuitState;
  circuitOpenedAt: Date | null;
  consecutiveFailures: number;
}

/**
 * D14: a webhook's circuit after one attempt. A success closes it. A failure
 * of the receiver counts; the 10th in a row opens the circuit, and a failed
 * half-open probe reopens it for another 15 minutes. `counts: false` is a
 * failure that is not the receiver's (the secret could not be opened): the
 * count is unchanged, and an interrupted probe goes back to `open`.
 */
export const circuitAfterAttempt = (
  current: Circuit,
  outcome: { succeeded: boolean; counts: boolean },
  now: Date,
): Circuit => {
  if (outcome.succeeded)
    return {
      circuitState: 'closed',
      circuitOpenedAt: null,
      consecutiveFailures: 0,
    };
  const failures = outcome.counts
    ? current.consecutiveFailures + 1
    : current.consecutiveFailures;
  if (current.circuitState === 'half_open')
    return {
      circuitState: 'open',
      circuitOpenedAt: now,
      consecutiveFailures: failures,
    };
  if (current.circuitState === 'open')
    return { ...current, consecutiveFailures: failures };
  if (outcome.counts && failures >= WEBHOOK_CIRCUIT_THRESHOLD)
    return {
      circuitState: 'open',
      circuitOpenedAt: now,
      consecutiveFailures: failures,
    };
  return { ...current, consecutiveFailures: failures };
};
