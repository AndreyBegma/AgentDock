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
 * batch insert nothing twice. #746 D4: each inserted `bypassed` row of a
 * known run is one of its `runs.retries`. #748: a `/cs-eco` batch's session is
 * kept as `sessionId` only when it is a session of this runner and project;
 * its external id is always kept, so a session learnt later still joins.
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
      await this.store(
        runnerId,
        project.id,
        parsed.data.rows,
        parsed.data.session,
      );
    }
  }

  /**
   * #748 D4: the batch's session, kept only when it is a Claude session of
   * this runner that belongs to the envelope's project — never another
   * project's, so a batch from Q's root cannot reach a card of P.
   */
  private async sessionOf(
    runnerId: string,
    projectId: string,
    externalId: string | undefined,
  ): Promise<string | null> {
    if (externalId === undefined) return null;
    const session = await this.prisma.agentSession.findUnique({
      where: {
        runnerId_runtime_externalId: {
          runnerId,
          runtime: 'claude',
          externalId,
        },
      },
      select: { id: true, projectId: true },
    });
    return session?.projectId === projectId ? session.id : null;
  }

  private async store(
    runnerId: string,
    projectId: string,
    rows: FilterStatRow[],
    session?: string,
  ): Promise<void> {
    const sessionId = await this.sessionOf(runnerId, projectId, session);
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
    // Only the rows actually inserted come back, so a resent batch counts no
    // retry twice (#746 D4).
    const inserted = await this.prisma.tokenSaverStat.createManyAndReturn({
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
        sessionId,
        sessionExternalId: session ?? null,
      })),
      skipDuplicates: true,
      select: { runId: true, bypassed: true },
    });
    const retries = new Map<string, number>();
    for (const r of inserted) {
      if (r.bypassed && r.runId !== null) {
        retries.set(r.runId, (retries.get(r.runId) ?? 0) + 1);
      }
    }
    for (const [id, count] of retries) {
      await this.prisma.run.update({
        where: { id },
        data: { retries: { increment: count } },
      });
    }
  }
}
