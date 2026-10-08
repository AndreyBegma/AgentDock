import { RUN_UPDATED_LIVE_EVENT, type RunLiveChange } from '@agentdock/shared';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ACTIVITY_OPTIONS, type ActivityOptions } from '../activity';
import { PrismaService } from '../database/prisma.service';
import { LiveService } from '../live/live.service';
import { runOfSlot } from './run-projection';

/** Slots rebuilt per transaction. */
export const RUNS_BATCH = 500;
const MAX_BATCHES_PER_TICK = 50;
const TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * Keeps one `orchestrator_slot` run per slot (spec 21 D7). A slot's
 * `updatedAt` is the time of its last event, not of its last write, so it
 * cannot be a cursor: a runner replaying its spool writes old timestamps.
 * Every slot write raises `slots.lastSeq` instead, so a run is rebuilt when
 * its `slotSeq` differs from its slot's `lastSeq` — or when it has no run
 * yet, which is also the backfill on first start. `slots` is read only.
 */
@Injectable()
export class RunsProjector implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RunsProjector.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<number> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
    @Inject(ACTIVITY_OPTIONS) private readonly options: ActivityOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.loop) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) =>
        this.logger.error(`run projection failed: ${(error as Error).message}`),
      );
    }, this.options.pollMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Rebuilds every stale run; returns how many it wrote. */
  tick(): Promise<number> {
    this.inFlight ??= this.drain().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async drain(): Promise<number> {
    let written = 0;
    for (let i = 0; i < MAX_BATCHES_PER_TICK; i += 1) {
      const changes = await this.batch();
      written += changes.length;
      for (const { projectId, change } of changes) {
        this.live.publish(
          `project:${projectId}`,
          RUN_UPDATED_LIVE_EVENT,
          change,
        );
      }
      if (changes.length < RUNS_BATCH) break;
    }
    return written;
  }

  private batch(): Promise<{ projectId: string; change: RunLiveChange }[]> {
    return this.prisma.$transaction(
      async (tx) => {
        // One writer at a time, across API instances too.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('agentdock:runs'))`;
        const stale = await tx.$queryRaw<{ id: string }[]>`
          SELECT s.id FROM slots s
          LEFT JOIN runs r ON r."slotId" = s.id
          WHERE r.id IS NULL OR r."slotSeq" IS DISTINCT FROM s."lastSeq"
          ORDER BY s."startedAt", s.id
          LIMIT ${RUNS_BATCH}`;
        if (stale.length === 0) return [];
        const slots = await tx.slot.findMany({
          where: { id: { in: stale.map((s) => s.id) } },
          include: {
            checkpoints: {
              orderBy: { position: 'desc' },
              take: 1,
              select: { summary: true },
            },
          },
        });
        const changes: { projectId: string; change: RunLiveChange }[] = [];
        for (const { checkpoints, ...slot } of slots) {
          const data = runOfSlot(slot, checkpoints[0]?.summary ?? null);
          const run = await tx.run.upsert({
            where: { slotId: slot.id },
            create: data,
            update: data,
            select: { id: true, status: true },
          });
          changes.push({ projectId: slot.projectId, change: run });
        }
        return changes;
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  }
}
