import {
  type CodeSentinelStateSlot,
  checkpointKindSchema,
} from '@agentdock/shared/protocol';
import type { Applied, EventOf } from './projection';
import type { SlotPatch, SlotProjection } from './slot-projection';

export type SnapshotEvent = EventOf<'orchestrator.snapshot'>;

/**
 * Code Sentinel's `state.json`, read on every runner (re)connect and change
 * (spec 16 D6). Every slot it lists is upserted into its run — a newer
 * `dispatchedAt` than the run's starts a new one. The snapshot is not
 * authority on ending: a slot it lists as ended updates an existing run but
 * never creates one, and a live run it omits is left to the tmux and worktree
 * collectors.
 */
export const projectSnapshot = async (
  slots: SlotProjection,
  applied: Applied<SnapshotEvent>,
): Promise<void> => {
  const source = {
    ts: applied.ts,
    seq: applied.seq,
    source: applied.event.source,
  };
  for (const [name, slot] of Object.entries(applied.event.data.state.slots)) {
    await slots.upsertRun(
      name,
      { ...source, ...(slot.issue ? { issue: slot.issue } : {}) },
      slot.dispatchedAt ?? null,
      { patch: snapshotPatch(slot), create: !slot.endedAt },
    );
  }
};

const snapshotPatch = (slot: CodeSentinelStateSlot): SlotPatch => {
  const patch: SlotPatch = {};
  if (slot.branch) patch.branch = slot.branch;
  if (slot.worktree) patch.worktree = slot.worktree;
  if (slot.model) {
    patch.model = slot.model;
    patch.modelWhy = slot.modelWhy ?? null;
  }
  if (slot.lastCheckpoint) {
    const kind = checkpointKindSchema.safeParse(slot.lastCheckpoint.checkpoint);
    patch.lastCheckpoint = kind.success ? kind.data : 'other';
  }
  if (slot.pr?.number) patch.prNumber = slot.pr.number;
  if (slot.pr?.url) patch.prUrl = slot.pr.url;
  if (slot.pr?.rollup) patch.prChecks = slot.pr.rollup;
  if (slot.status === 'merged') patch.prState = 'merged';
  return patch;
};
