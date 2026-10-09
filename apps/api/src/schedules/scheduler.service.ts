import {
  SCHEDULE_CATCH_UP_MAX_MS,
  SCHEDULE_FIRING_REASONS,
} from '@agentdock/shared';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Prisma, ScheduleMissedPolicy } from '@prisma/client';
import { Client } from 'pg';
import { PrismaService } from '../database/prisma.service';
import { RunnerPresence } from '../runners/runner-presence';
import { CronSchedule } from './cron';
import { planClaim } from './missed';
import { ScheduleFirer } from './schedule-firer';
import { ScheduleLive } from './schedule-live';
import { SCHEDULER_OPTIONS, type SchedulerOptions } from './scheduler-options';

/** D5: the session-level advisory lock only the ticking instance holds. */
const LEADER_LOCK = 'agentdock.scheduler';
const TRANSACTION_TIMEOUT_MS = 30_000;

interface DueRow {
  id: string;
  projectId: string;
  runnerId: string;
  cron: string;
  timezone: string;
  missedPolicy: ScheduleMissedPolicy;
  nextRunAt: Date;
}

/** Firings a claim wrote, for publishing and firing after commit. */
interface Claimed {
  projectId: string;
  due: bigint[];
  skipped: bigint[];
}

/**
 * The scheduler loop (spec 25 D5). One API instance — the one holding
 * `pg_try_advisory_lock` on its own connection — ticks every 15 s; the others
 * retry the lock every 30 s, so a dead leader's connection closing hands the
 * loop over. A tick settles finished runs, claims due schedules with
 * `FOR UPDATE SKIP LOCKED`, writes their firings and the next `nextRunAt` in
 * one transaction, and sends the commands after it commits.
 */
@Injectable()
export class SchedulerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(SchedulerService.name);
  private timer: NodeJS.Timeout | undefined;
  private lock: Client | null = null;
  private lastAttempt = 0;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: RunnerPresence,
    private readonly firer: ScheduleFirer,
    private readonly live: ScheduleLive,
    @Inject(SCHEDULER_OPTIONS) private readonly options: SchedulerOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.enabled) return;
    this.timer = setInterval(() => {
      void this.loop().catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(`scheduler tick failed: ${reason}`);
      });
    }, this.options.tickMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.release();
  }

  get isLeader(): boolean {
    return this.lock !== null;
  }

  /** Takes the leader lock if it is free; true while this instance holds it. */
  async lead(): Promise<boolean> {
    if (this.lock) return true;
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    try {
      await client.connect();
      const result = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [LEADER_LOCK],
      );
      if (!result.rows[0]?.locked) {
        await client.end();
        return false;
      }
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    // A dropped connection drops the lock with it: stop ticking.
    client.on('error', (error) => {
      this.logger.warn(`scheduler lock connection lost: ${error.message}`);
      if (this.lock === client) this.lock = null;
    });
    client.on('end', () => {
      if (this.lock === client) this.lock = null;
    });
    this.lock = client;
    this.logger.log('scheduler leadership taken');
    return true;
  }

  /** Gives the lock up by closing its connection. */
  async release(): Promise<void> {
    const client = this.lock;
    this.lock = null;
    await client?.end().catch(() => undefined);
  }

  /** One timer beat: a follower retries the lock every `leaderRetryMs`, a leader ticks. */
  private async loop(): Promise<void> {
    if (!this.lock) {
      const now = Date.now();
      if (now - this.lastAttempt < this.options.leaderRetryMs) return;
      this.lastAttempt = now;
      if (!(await this.lead())) return;
    }
    await this.tick();
  }

  /**
   * One pass; `null` when this instance is not the leader or a pass is
   * already running. Returns the ids of the firings it sent.
   */
  async tick(now = new Date()): Promise<bigint[] | null> {
    if (!this.lock || this.running) return null;
    this.running = true;
    try {
      await this.settleFinishedRuns();
      await this.failStaleDue(now);
      const claimed = await this.prisma.$transaction(
        (tx) => this.claim(tx, now),
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
      const fired: bigint[] = [];
      for (const batch of claimed) {
        for (const id of batch.skipped) {
          const row = await this.prisma.scheduleFiring.findUnique({
            where: { id },
          });
          if (row) this.live.firing(batch.projectId, row);
        }
        for (const id of batch.due) {
          try {
            await this.firer.fire(id);
            fired.push(id);
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            this.logger.error(`firing ${id} failed to fire: ${reason}`);
          }
        }
      }
      return fired;
    } finally {
      this.running = false;
    }
  }

  /** D5 step 2–3: claims due schedules and writes their firings. */
  private async claim(
    tx: Prisma.TransactionClient,
    now: Date,
  ): Promise<Claimed[]> {
    const rows = await tx.$queryRaw<DueRow[]>`
      SELECT s.id, s."projectId", p."runnerId", s.cron, s.timezone,
             s."missedPolicy", s."nextRunAt"
        FROM schedules s
        JOIN projects p ON p.id = s."projectId"
       WHERE s.enabled AND s."nextRunAt" <= ${now}
       ORDER BY s."nextRunAt"
       LIMIT ${this.options.batch}
         FOR UPDATE OF s SKIP LOCKED`;
    const claimed: Claimed[] = [];
    for (const row of rows) {
      const result = await this.claimOne(tx, row, now);
      if (result) claimed.push(result);
    }
    return claimed;
  }

  private async claimOne(
    tx: Prisma.TransactionClient,
    row: DueRow,
    now: Date,
  ): Promise<Claimed | null> {
    let schedule: CronSchedule;
    try {
      schedule = CronSchedule.parse(row.cron, row.timezone, now);
    } catch (error) {
      // Validated on save; a stored row that no longer parses stops here.
      this.logger.error(`schedule ${row.id}: ${(error as Error).message}`);
      await tx.schedule.update({
        where: { id: row.id },
        data: { nextRunAt: null },
      });
      return null;
    }
    // D9: a `catch_up` occurrence that failed with the runner offline waits
    // for the runner, within the 24-hour cap.
    const offline = await tx.scheduleFiring.findFirst({
      where: {
        scheduleId: row.id,
        scheduledFor: row.nextRunAt,
        kind: 'cron',
        status: 'failed',
        reason: SCHEDULE_FIRING_REASONS.runnerOffline,
      },
      select: { id: true },
    });
    if (
      offline &&
      row.missedPolicy === 'catch_up' &&
      !this.presence.isConnected(row.runnerId) &&
      now.getTime() - row.nextRunAt.getTime() <= SCHEDULE_CATCH_UP_MAX_MS
    ) {
      return null;
    }

    const plan = planClaim({
      schedule,
      due: row.nextRunAt,
      now,
      policy: row.missedPolicy,
      dueRecorded: offline !== null,
    });
    const skipped = plan.skipped
      ? await tx.scheduleFiring.createManyAndReturn({
          data: [
            {
              scheduleId: row.id,
              scheduledFor: plan.skipped.scheduledFor,
              kind: 'cron',
              status: 'skipped',
              reason: plan.skipped.reason,
              missedCount: plan.skipped.missedCount,
              finishedAt: now,
            },
          ],
          skipDuplicates: true,
          select: { id: true },
        })
      : [];
    const due = plan.fire
      ? await tx.scheduleFiring.createManyAndReturn({
          data: [
            {
              scheduleId: row.id,
              scheduledFor: plan.fire.scheduledFor,
              kind: plan.fire.kind,
              status: 'due',
            },
          ],
          // The unique key: an occurrence already written never fires twice.
          skipDuplicates: true,
          select: { id: true },
        })
      : [];
    await tx.schedule.update({
      where: { id: row.id },
      data: { nextRunAt: plan.nextRunAt },
    });
    return {
      projectId: row.projectId,
      due: due.map((f) => f.id),
      skipped: skipped.map((f) => f.id),
    };
  }

  /** D8: a `started` firing ends with its run (#21). */
  async settleFinishedRuns(): Promise<void> {
    const firings = await this.prisma.scheduleFiring.findMany({
      where: {
        status: 'started',
        run: { status: { in: ['succeeded', 'failed', 'abandoned'] } },
      },
      include: { run: { select: { status: true, outcome: true } } },
      take: 100,
    });
    for (const { run, ...firing } of firings) {
      if (!run) continue;
      await this.firer.settle(
        firing,
        run.status === 'succeeded'
          ? { status: 'succeeded', sent: false }
          : {
              status: 'failed',
              reason: SCHEDULE_FIRING_REASONS.runFailed,
              ...(run.outcome
                ? { error: { code: run.status, message: run.outcome } }
                : {}),
              sent: false,
            },
      );
    }
  }

  /** A `due` firing whose API died before sending it: failed, never resent (at-most-once). */
  private async failStaleDue(now: Date): Promise<void> {
    const stale = await this.prisma.scheduleFiring.findMany({
      where: {
        status: 'due',
        scheduledFor: { lt: new Date(now.getTime() - this.options.staleDueMs) },
      },
      take: 100,
    });
    for (const firing of stale) {
      await this.firer.settle(firing, {
        status: 'failed',
        reason: SCHEDULE_FIRING_REASONS.commandFailed,
        error: {
          code: 'not_sent',
          message: 'The API stopped before sending it',
        },
        sent: false,
      });
    }
  }
}
