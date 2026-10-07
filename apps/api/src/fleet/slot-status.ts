import type { PaneState, PrState, SlotStatus } from '@agentdock/shared';

/** What a slot's status is derived from — the columns the projector keeps. */
export interface SlotStatusInputs {
  /** null until the tmux session is first seen. */
  sessionAlive: boolean | null;
  pane: PaneState | null;
  worktreeExists: boolean;
  prState: PrState | null;
}

const PANE_STATUS: Record<PaneState, SlotStatus> = {
  busy: 'running',
  prompt: 'prompt',
  idle: 'idle',
  quota: 'quota',
};

/**
 * Spec 11 D8. While the session lives, the pane decides. Once it is gone the
 * slot is `ended` when its PR merged or its worktree is gone, else `stale` —
 * or `dispatched`, when no session was ever seen.
 */
export const deriveSlotStatus = (inputs: SlotStatusInputs): SlotStatus => {
  if (inputs.sessionAlive) {
    return inputs.pane ? PANE_STATUS[inputs.pane] : 'running';
  }
  if (inputs.prState === 'merged' || !inputs.worktreeExists) return 'ended';
  return inputs.sessionAlive === null ? 'dispatched' : 'stale';
};
