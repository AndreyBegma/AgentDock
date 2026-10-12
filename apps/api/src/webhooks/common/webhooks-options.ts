import { WEBHOOK_REQUEST_TIMEOUT_MS } from '@agentdock/shared';
import { type HostResolver, systemResolver } from './ssrf-guard';

/** How the webhooks module paces its loops and reaches targets; tests override it. */
export interface WebhooksOptions {
  /**
   * `WEBHOOKS_WORKER_ENABLED` — `false` keeps the dispatcher and the delivery
   * worker off on this instance. Never started under `APP_ENV=test`: suites
   * drive them.
   */
  workerEnabled: boolean;
  /** Per-attempt timeout (D12). */
  requestTimeoutMs: number;
  /** Host resolution for the SSRF guard (D15); tests inject a fake. */
  resolve: HostResolver;
}

export const WEBHOOKS_OPTIONS = Symbol('WEBHOOKS_OPTIONS');

export const webhooksOptionsFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): WebhooksOptions => ({
  workerEnabled:
    env.APP_ENV !== 'test' &&
    env.WEBHOOKS_WORKER_ENABLED?.trim().toLowerCase() !== 'false',
  requestTimeoutMs: WEBHOOK_REQUEST_TIMEOUT_MS,
  resolve: systemResolver,
});
