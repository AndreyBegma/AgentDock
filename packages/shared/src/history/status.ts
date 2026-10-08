import type { PrState, SlotStatus } from '../fleet/contracts';
import type { CheckpointKind } from '../protocol';
import type { RunStatus } from './contracts';

/** The slot columns a run's status is derived from (spec 21 D7). */
export interface RunStatusInputs {
  status: SlotStatus;
  prState: PrState | null;
  prNumber: number | null;
  lastCheckpoint: CheckpointKind | null;
}

/**
 * Spec 21 D7. A merged PR is the only success. Once the worker's session is
 * gone (`stale` or `ended`) the run is over: `failed` with a PR closed
 * unmerged, `abandoned` without any PR, `waiting_person` while its PR is open.
 * While the session lives, a `blocked`/`misclassified` checkpoint is
 * `blocked`, a launch prompt or the quota banner — or an open PR with the
 * worker idle — is `waiting_person`, and anything else is `running`. A slot
 * resumed in the same row comes back to `running`.
 */
export const deriveRunStatus = (slot: RunStatusInputs): RunStatus => {
  if (slot.prState === 'merged') return 'succeeded';
  const hasPr = slot.prNumber !== null || slot.prState !== null;
  if (slot.status === 'stale' || slot.status === 'ended') {
    if (slot.prState === 'closed') return 'failed';
    return hasPr ? 'waiting_person' : 'abandoned';
  }
  if (
    slot.lastCheckpoint === 'blocked' ||
    slot.lastCheckpoint === 'misclassified'
  ) {
    return 'blocked';
  }
  if (slot.status === 'prompt' || slot.status === 'quota') {
    return 'waiting_person';
  }
  if (slot.status === 'idle' && slot.prState === 'open')
    return 'waiting_person';
  return 'running';
};
