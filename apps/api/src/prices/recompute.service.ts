import type { RecomputeProgress } from '@agentdock/shared';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { hourOf, RollupService } from '../usage/rollup.service';
import { usageError } from '../usage/usage-error';
import { CostService } from './cost.service';
import type { RecomputeDto } from './dto';

/** Serializes the "one recompute at a time" check (D7). */
const RECOMPUTE_LOCK = 13_015;

export const DEFAULT_RECOMPUTE_BATCH = 1000;

/** A batch rewrites up to `USAGE_RECOMPUTE_BATCH` rows and rebuilds their hours. */
const BATCH_TRANSACTION_TIMEOUT_MS = 120_000;

const progressSelect = {
  id: true,
  versionId: true,
  version: { select: { number: true } },
  from: true,
  to: true,
  status: true,
  processed: true,
  total: true,
  error: true,
  createdAt: true,
  finishedAt: true,
} as const satisfies Prisma.PriceRecomputeSelect;

const requestSelect = {
  id: true,
  ts: true,
  model: true,
  input: true,
  output: true,
  cacheRead: true,
  cacheWrite5m: true,
  cacheWrite1h: true,
  reasoning: true,
} as const satisfies Prisma.LlmRequestSelect;

type RequestRow = Prisma.LlmRequestGetPayload<{
  select: typeof requestSelect;
}>;

type ProgressRow = Prisma.PriceRecomputeGetPayload<{
  select: typeof progressSelect;
}>;

const toProgress = ({ version, ...row }: ProgressRow): RecomputeProgress => ({
  ...row,
  versionNumber: version.number,
  from: row.from.toISOString(),
  to: row.to.toISOString(),
  createdAt: row.createdAt.toISOString(),
  finishedAt: row.finishedAt?.toISOString() ?? null,
});

/**
 * Re-prices `llm_requests` in a range with a chosen version (spec 13 D7), in
 * the background, in batches ordered by time; each batch rebuilds the rollup
 * hours it touched in the same transaction, so rollups never disagree with
 * the requests. One runs at a time; one interrupted by a restart is failed.
 */
@Injectable()
export class RecomputeService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RecomputeService.name);
  private readonly batchSize: number;
  /** The job in flight, for tests and shutdown. */
  private running: Promise<void> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly cost: CostService,
    private readonly rollups: RollupService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    const configured = Number(config.get<string>('USAGE_RECOMPUTE_BATCH'));
    this.batchSize =
      Number.isInteger(configured) && configured > 0
        ? configured
        : DEFAULT_RECOMPUTE_BATCH;
  }

  async onApplicationBootstrap(): Promise<void> {
    const { count } = await this.prisma.priceRecompute.updateMany({
      where: { status: { in: ['queued', 'running'] } },
      data: {
        status: 'failed',
        error: 'interrupted by an API restart',
        finishedAt: new Date(),
      },
    });
    if (count > 0) this.logger.warn(`${count} interrupted recompute(s) failed`);
  }

  async start(
    dto: RecomputeDto,
    adminId: string,
    ctx: AuditContext,
  ): Promise<RecomputeProgress> {
    const from = new Date(dto.from);
    const to = new Date(dto.to);
    if (from >= to) {
      throw usageError(400, 'invalid_range', 'from must be before to');
    }
    const version = await this.prisma.priceVersion.findUnique({
      where: { id: dto.versionId },
      select: { id: true, number: true },
    });
    if (!version) {
      throw usageError(404, 'not_found', 'Price version not found');
    }

    const job = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RECOMPUTE_LOCK}::int, 0)`;
      const active = await tx.priceRecompute.findFirst({
        where: { status: { in: ['queued', 'running'] } },
        select: { id: true },
      });
      if (active) {
        throw usageError(
          409,
          'recompute_running',
          `Recompute ${active.id} is still running`,
        );
      }
      const total = await tx.llmRequest.count({
        where: { ts: { gte: from, lt: to } },
      });
      return tx.priceRecompute.create({
        data: { versionId: version.id, from, to, total, createdById: adminId },
        select: progressSelect,
      });
    });

    await this.audit.record({
      ...ctx,
      action: 'prices.recompute',
      target: { type: 'price_recompute', id: job.id },
      after: {
        versionId: version.id,
        versionNumber: version.number,
        from: dto.from,
        to: dto.to,
        total: job.total,
      },
      result: 'ok',
    });
    this.running = this.run(job.id);
    return toProgress(job);
  }

  async get(id: string): Promise<RecomputeProgress> {
    const job = await this.prisma.priceRecompute.findUnique({
      where: { id },
      select: progressSelect,
    });
    if (!job) throw usageError(404, 'not_found', 'Recompute not found');
    return toProgress(job);
  }

  /** Resolves when the job in flight (if any) has finished. */
  idle(): Promise<void> {
    return this.running;
  }

  private async run(id: string): Promise<void> {
    try {
      const job = await this.prisma.priceRecompute.update({
        where: { id },
        data: { status: 'running' },
        select: { versionId: true, from: true, to: true },
      });
      const pricer = await this.cost.forVersion(job.versionId);
      let cursor: { ts: Date; id: string } | null = null;
      let processed = 0;
      for (;;) {
        const after: { ts: Date; id: string } | null = cursor;
        const batch: RequestRow[] = await this.prisma.llmRequest.findMany({
          where: {
            ts: { gte: job.from, lt: job.to },
            ...(after
              ? {
                  OR: [
                    { ts: { gt: after.ts } },
                    { ts: after.ts, id: { gt: after.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ ts: 'asc' }, { id: 'asc' }],
          take: this.batchSize,
          select: requestSelect,
        });
        if (batch.length === 0) break;
        processed += batch.length;
        await this.prisma.$transaction(
          async (tx) => {
            for (const { id: requestId, ts, model, ...tokens } of batch) {
              await tx.llmRequest.update({
                where: { id: requestId },
                data: pricer.price(model, tokens),
              });
            }
            await this.rollups.rebuildHours(
              tx,
              batch.map((r) => hourOf(r.ts)),
            );
            await tx.priceRecompute.update({
              where: { id },
              data: { processed },
            });
          },
          { timeout: BATCH_TRANSACTION_TIMEOUT_MS },
        );
        const last = batch[batch.length - 1];
        cursor = { ts: last.ts, id: last.id };
      }
      await this.prisma.priceRecompute.update({
        where: { id },
        data: { status: 'done', finishedAt: new Date() },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`recompute ${id} failed: ${reason}`);
      await this.prisma.priceRecompute
        .update({
          where: { id },
          data: {
            status: 'failed',
            error: reason.slice(0, 1000),
            finishedAt: new Date(),
          },
        })
        .catch(() => undefined);
    }
  }
}
