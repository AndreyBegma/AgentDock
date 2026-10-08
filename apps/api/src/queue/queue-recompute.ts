import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { loadQueueInputs } from './queue-inputs';
import { type ComputedQueueItem, computeQueue } from './queue-state';

type Tx = Prisma.TransactionClient;

const rowOf = (item: ComputedQueueItem) => ({
  state: item.computed.state,
  why: item.computed.why,
  clears: item.computed.clears,
  source: item.source,
  orchestratorState: item.orchestrator?.state ?? null,
  orchestratorWhy: item.orchestrator?.why ?? null,
  orchestratorClears: item.orchestrator?.clears ?? null,
  blockers: item.blockers,
  waveSlots: item.waveSlots,
});

type StateRow = ReturnType<typeof rowOf>;

const same = (
  before: Prisma.QueueStateRowGetPayload<object>,
  after: StateRow,
): boolean =>
  before.state === after.state &&
  before.why === after.why &&
  before.clears === after.clears &&
  before.source === after.source &&
  before.orchestratorState === after.orchestratorState &&
  before.orchestratorWhy === after.orchestratorWhy &&
  before.orchestratorClears === after.orchestratorClears &&
  JSON.stringify(before.blockers) === JSON.stringify(after.blockers) &&
  JSON.stringify(before.waveSlots) === JSON.stringify(after.waveSlots);

/**
 * Recomputes a project's `queue_states` from its cache, slots and latest
 * round, inside the caller's transaction. A row whose state did not change
 * keeps its `computedAt`; an issue that left the queue loses its row.
 */
@Injectable()
export class QueueRecompute {
  /** True when any row was added, changed or removed. */
  async run(tx: Tx, projectId: string): Promise<boolean> {
    const loaded = await loadQueueInputs(tx, projectId);
    if (!loaded) return false;
    const items = computeQueue(loaded.inputs);
    const existing = new Map(
      (await tx.queueStateRow.findMany({ where: { projectId } })).map((r) => [
        r.issueNumber,
        r,
      ]),
    );
    const now = new Date();
    let changed = false;
    for (const item of items) {
      const row = rowOf(item);
      const before = existing.get(item.number);
      existing.delete(item.number);
      if (before && same(before, row)) continue;
      const data = {
        ...row,
        waveSlots: row.waveSlots?.map((s) => ({ ...s })) ?? Prisma.DbNull,
        computedAt: now,
      };
      await tx.queueStateRow.upsert({
        where: {
          projectId_issueNumber: { projectId, issueNumber: item.number },
        },
        create: { projectId, issueNumber: item.number, ...data },
        update: data,
      });
      changed = true;
    }
    if (existing.size > 0) {
      await tx.queueStateRow.deleteMany({
        where: { projectId, issueNumber: { in: [...existing.keys()] } },
      });
      changed = true;
    }
    return changed;
  }
}
