import type { RunnerEvent } from '@agentdock/shared/protocol';
import { Events } from '../../usage/testing/usage-e2e';

/** Seeded Sonnet input price is $3 / MTok: 500 000 input tokens cost $1.50. */
export const SONNET = 'claude-sonnet-4-5-20250929';
export const UNPRICED_MODEL = 'acme-unknown-model-1';
export const DOLLAR_AND_A_HALF = { input: 500_000 };

/** Session fixtures on one runner, as #12 would see them. */
export class Feed extends Events {
  /** A session at `cwd`, correlated to `projectId` (and `slot`) when given. */
  session(
    id: string,
    cwd: string,
    ts: string,
    extra: { projectId?: string; slot?: string; parent?: string } = {},
  ): RunnerEvent {
    return this.next(
      'session.observed',
      id,
      {
        cwd,
        startedAt: ts,
        parsed: true,
        ...(extra.projectId ? { projectId: extra.projectId } : {}),
        ...(extra.slot ? { slot: extra.slot } : {}),
        ...(extra.parent ? { parent: { sessionId: extra.parent } } : {}),
      },
      ts,
    );
  }

  /** A $1.50 request (seeded prices), or an unpriced one. */
  spend(sessionId: string, requestId: string, ts: string, priced = true) {
    return this.request(
      sessionId,
      requestId,
      priced ? SONNET : UNPRICED_MODEL,
      DOLLAR_AND_A_HALF,
      ts,
    );
  }
}
