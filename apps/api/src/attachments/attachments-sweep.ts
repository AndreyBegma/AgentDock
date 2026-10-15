import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { type Queue, Worker } from 'bullmq';
import { PrismaService } from '../database/prisma.service';
import { AttachmentStore } from './attachment-store';
import { AttachmentsService } from './attachments.service';
import {
  ATTACHMENTS_OPTIONS,
  type AttachmentsOptions,
} from './attachments-options';

export const ATTACHMENTS_QUEUE = 'attachments';
const SWEEP_JOB = 'attachments.sweep';
const SWEEP_SCHEDULER = 'attachments.sweep';
/** Daily at 04:15, server time. */
const SWEEP_CRON = '15 4 * * *';
/**
 * A file with no row, or a temporary upload, younger than this is left
 * alone: an upload may be between its move into place and its commit.
 */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;
const STARTUP_RETRY_MS = [1_000, 5_000, 30_000, 60_000];
const CLOSE_TIMEOUT_MS = 5_000;

export interface SweepResult {
  /** Pending uploads past `expiresAt`, rows and files. */
  expired: number;
  /** Files with no row. */
  orphans: number;
  /** Abandoned temporary uploads. */
  temps: number;
}

/**
 * #309 D3 and "Data / Schema": the daily cleanup — pending uploads past
 * `expiresAt` with their files, files with no row (a cascade deletes rows,
 * never files), and abandoned temporary uploads. A BullMQ repeatable job,
 * so it does nothing without `REDIS_URL`, as other jobs do; never under
 * `APP_ENV=test`, where tests call `sweep` themselves.
 */
@Injectable()
export class AttachmentsSweep
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AttachmentsSweep.name);
  private worker: Worker | null = null;
  private retry: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: AttachmentStore,
    private readonly attachments: AttachmentsService,
    @Inject(ATTACHMENTS_OPTIONS) private readonly options: AttachmentsOptions,
    @Optional()
    @InjectQueue(ATTACHMENTS_QUEUE)
    private readonly queue?: Queue,
  ) {}

  async sweep(now = new Date()): Promise<SweepResult> {
    const expired = await this.prisma.attachment.findMany({
      where: { cardId: null, expiresAt: { lte: now } },
      select: { id: true, projectId: true },
    });
    if (expired.length > 0) {
      // A claim that won the race keeps its row: it is no longer pending.
      await this.prisma.attachment.deleteMany({
        where: {
          id: { in: expired.map((a) => a.id) },
          cardId: null,
          expiresAt: { lte: now },
        },
      });
      const kept = new Set(
        (
          await this.prisma.attachment.findMany({
            where: { id: { in: expired.map((a) => a.id) } },
            select: { id: true },
          })
        ).map((a) => a.id),
      );
      for (const a of expired) {
        if (!kept.has(a.id)) {
          await this.attachments.removeFiles(a.projectId, [a.id]);
        }
      }
    }

    const before = now.getTime() - ORPHAN_GRACE_MS;
    const stale: { projectId: string; id: string }[] = [];
    for await (const file of this.store.list()) {
      if (file.modifiedAt.getTime() < before) stale.push(file);
    }
    let orphans = 0;
    if (stale.length > 0) {
      const rows = new Set(
        (
          await this.prisma.attachment.findMany({
            where: { id: { in: stale.map((f) => f.id) } },
            select: { id: true },
          })
        ).map((a) => a.id),
      );
      for (const file of stale) {
        if (rows.has(file.id)) continue;
        await this.store.remove(file.projectId, file.id);
        orphans += 1;
      }
    }

    let temps = 0;
    for (const temp of await this.store.temps()) {
      if (temp.modifiedAt.getTime() >= before) continue;
      await this.store.removeTemp(temp.name);
      temps += 1;
    }
    return { expired: expired.length, orphans, temps };
  }

  onApplicationBootstrap(): void {
    if (!this.options.sweepEnabled || !this.queue) return;
    const queue = this.queue;
    this.worker = new Worker(
      ATTACHMENTS_QUEUE,
      async (job) => {
        if (job.name !== SWEEP_JOB) return;
        const result = await this.sweep();
        if (result.expired + result.orphans + result.temps > 0) {
          this.logger.log(
            `swept ${result.expired} expired uploads, ${result.orphans} orphan files, ${result.temps} temporary files`,
          );
        }
      },
      { connection: queue.opts.connection, prefix: queue.opts.prefix },
    );
    this.worker.on('failed', (_job, error) => {
      this.logger.error(`attachments sweep failed: ${error.message}`);
    });
    this.worker.on('error', (error) => {
      this.logger.warn(`attachments worker: ${error.message}`);
    });
    void this.schedule(queue, 0);
  }

  /** Idempotent across instances; retried until Redis answers. */
  private async schedule(queue: Queue, attempt: number): Promise<void> {
    if (this.stopped) return;
    try {
      await queue.upsertJobScheduler(
        SWEEP_SCHEDULER,
        { pattern: SWEEP_CRON },
        {
          name: SWEEP_JOB,
          data: {},
          opts: { removeOnComplete: true, removeOnFail: { age: 86_400 } },
        },
      );
    } catch (error) {
      const delay =
        STARTUP_RETRY_MS[Math.min(attempt, STARTUP_RETRY_MS.length - 1)];
      this.logger.warn(
        `attachments sweep not scheduled (${(error as Error).message}); retrying in ${delay} ms`,
      );
      this.retry = setTimeout(() => {
        void this.schedule(queue, attempt + 1);
      }, delay);
      this.retry.unref();
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    const worker = this.worker;
    if (!worker) return;
    const timeout = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), CLOSE_TIMEOUT_MS).unref();
    });
    if ((await Promise.race([worker.close(), timeout])) === 'timeout') {
      await worker.close(true);
    }
  }
}
