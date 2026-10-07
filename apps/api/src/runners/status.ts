import type { RunnerStatus } from '@agentdock/shared';

export interface StatusInput {
  revokedAt: Date | null;
  /** When the live socket last proved alive (hello or heartbeat); `null` with no socket. */
  lastBeatAt: number | null;
}

/** Spec D5 / D10: derived from the live connection, never stored. */
export const deriveStatus = (
  { revokedAt, lastBeatAt }: StatusInput,
  now: number,
  staleAfterMs: number,
): RunnerStatus => {
  if (revokedAt) return 'revoked';
  if (lastBeatAt === null) return 'offline';
  return now - lastBeatAt < staleAfterMs ? 'online' : 'stale';
};
