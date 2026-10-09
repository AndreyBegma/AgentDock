import { deriveRunStatus, type RunStatus } from '@agentdock/shared';
import type { Prisma, Slot } from '@prisma/client';

const FINISHED: ReadonlySet<RunStatus> = new Set([
  'succeeded',
  'failed',
  'abandoned',
]);

/**
 * The `orchestrator_slot` run of a slot (spec 21 D7) — a pure function of the
 * slot and its last checkpoint's summary, so rebuilding it from the same slot
 * writes the same row. A finished run ends when the slot ended, else when it
 * last changed (the session vanished).
 */
export const runOfSlot = (
  slot: Slot,
  outcome: string | null,
): Omit<Prisma.RunUncheckedCreateInput, 'id'> => {
  const status = deriveRunStatus(slot);
  const endedAt = FINISHED.has(status)
    ? (slot.endedAt ?? slot.updatedAt)
    : null;
  return {
    kind: 'orchestrator_slot',
    projectId: slot.projectId,
    slotId: slot.id,
    issue: slot.issue,
    runtime: slot.runtime,
    model: slot.model,
    output: slot.prNumber !== null ? 'pr' : null,
    status,
    outcome: outcome === null || outcome === '' ? null : outcome,
    prNumber: slot.prNumber,
    prUrl: slot.prUrl,
    triggeredByType: 'orchestrator',
    startedAt: slot.startedAt,
    endedAt,
    durationMs:
      endedAt === null
        ? null
        : Math.max(0, endedAt.getTime() - slot.startedAt.getTime()),
    slotSeq: slot.lastSeq,
    updatedAt: slot.updatedAt,
  };
};
