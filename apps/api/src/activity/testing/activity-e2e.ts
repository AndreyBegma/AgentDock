import type { RunnerEvent } from '@agentdock/shared/protocol';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../database/prisma.service';

/**
 * Clears what the activity and run projectors read and write. `audit_records`
 * cannot be truncated (#8's trigger), so audit tests compare against the
 * records they create.
 */
export const resetActivity = (prisma: PrismaService) =>
  prisma.$executeRawUnsafe(
    'TRUNCATE TABLE activity_items, activity_projector_state, runs, runners, projects CASCADE',
  );

/** Stores events as the runner ingest does, without running its sinks. */
export const storeEvents = async (
  prisma: PrismaService,
  runnerId: string,
  events: RunnerEvent[],
): Promise<void> => {
  await prisma.event.createMany({
    data: events.map((event) => ({
      runnerId,
      seq: BigInt(event.seq),
      ts: new Date(event.ts),
      type: event.type,
      source: event.source,
      projectRepo: event.project?.repo ?? null,
      projectRoot: event.project?.root ?? null,
      slot: event.slot ?? null,
      issue: event.issue ?? null,
      session: event.session ?? Prisma.DbNull,
      data: event.data as Prisma.InputJsonValue,
    })),
  });
};

/** The items without their own id, for replay comparisons. */
export const itemRows = async (prisma: PrismaService) =>
  (
    await prisma.activityItem.findMany({
      orderBy: [{ sourceKind: 'asc' }, { sourceId: 'asc' }],
    })
  ).map(({ id: _id, ...row }) => row);
