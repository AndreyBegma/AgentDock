import {
  FILTER_STATS_EVENT,
  type FilterStatRow,
  filterStatsDataSchema,
} from '@nautelle/shared';
import type { RunnerEvent } from '@nautelle/shared/protocol';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import {
  type RunnerEventSink,
  RunnerEventSinks,
} from '../runners/runner-event-sinks';

/**
 * Sink `token-saver`: `filter.stats` rows into `token_saver_stats` (#445 D12).
 * The project is the envelope's, by `(runner, root)`; a row's run is kept
 * only when it is a run of that project — else `null`, so another project's
 * run never shows a stranger's savings. The runner's row id makes a resent
 * batch insert nothing twice.
 */
@Injectable()
export class TokenSaverSink implements RunnerEventSink, OnApplicationBootstrap {
  readonly name = 'token-saver';
  private readonly logger = new Logger(TokenSaverSink.name);

  constructor(
    private readonly sinks: RunnerEventSinks,
    private readonly prisma: PrismaService,
  ) {}

  onApplicationBootstrap(): void {
    this.sinks.register(this);
  }

  async handle(runnerId: string, events: RunnerEvent[]): Promise<void> {
    for (const event of events) {
      if (event.type !== FILTER_STATS_EVENT) continue;
      const parsed = filterStatsDataSchema.safeParse(event.data);
      const root = event.project?.root;
      if (!parsed.success || !root) {
        this.logger.warn(
          `runner ${runnerId}: malformed ${event.type} (seq ${event.seq}), skipped`,
        );
        continue;
      }
      const project = await this.prisma.project.findFirst({
        where: { runnerId, rootPath: root },
        select: { id: true },
      });
      if (!project) {
        this.logger.warn(
          `runner ${runnerId}: ${event.type} (seq ${event.seq}) for an unknown project, skipped`,
        );
        continue;
      }
      await this.store(project.id, parsed.data.rows);
    }
  }

  private async store(projectId: string, rows: FilterStatRow[]): Promise<void> {
    const named = [
      ...new Set(rows.flatMap((r) => (r.runId === null ? [] : [r.runId]))),
    ];
    const known = new Set(
      named.length === 0
        ? []
        : (
            await this.prisma.run.findMany({
              where: { id: { in: named }, projectId },
              select: { id: true },
            })
          ).map((r) => r.id),
    );
    await this.prisma.tokenSaverStat.createMany({
      data: rows.map((r) => ({
        id: r.id,
        projectId,
        runId: r.runId !== null && known.has(r.runId) ? r.runId : null,
        runKind: r.runKind,
        filter: r.filter,
        program: r.program ?? null,
        rawBytes: r.rawBytes,
        keptBytes: r.keptBytes,
        bypassed: r.bypassed,
        passedThrough: r.passedThrough,
        createdAt: new Date(r.at),
      })),
      skipDuplicates: true,
    });
  }
}
