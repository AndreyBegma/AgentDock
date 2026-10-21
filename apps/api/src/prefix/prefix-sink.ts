import {
  PREFIX_MEASURED_EVENT,
  PREFIX_OVERLAY_STALE_EVENT,
  type PrefixMeasuredData,
  prefixMeasuredDataSchema,
  prefixOverlayStaleDataSchema,
  type RunnerEvent,
} from '@nautelle/shared/protocol';
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
import { PrefixOverlaysService } from './prefix-overlays.service';
import { PrefixProposer } from './prefix-proposer';
import { PrefixSummaryService } from './prefix-summary.service';

const SCHEMAS = {
  [PREFIX_MEASURED_EVENT]: prefixMeasuredDataSchema,
  [PREFIX_OVERLAY_STALE_EVENT]: prefixOverlayStaleDataSchema,
} as const;

/**
 * Sink `prefix` (#751 B1, B10, B13): `prefix.measured` rows into
 * `run_prefix_parts`, and `prefix.overlay_stale` into the overlay's state.
 * The project is the envelope's, by `(runner, root)`; an event whose run is
 * not a run of that project is dropped, so a runner can never write into
 * another project. A resent `prefix.measured` inserts nothing twice.
 */
@Injectable()
export class PrefixSink implements RunnerEventSink, OnApplicationBootstrap {
  readonly name = 'prefix';
  private readonly logger = new Logger(PrefixSink.name);

  constructor(
    private readonly sinks: RunnerEventSinks,
    private readonly prisma: PrismaService,
    private readonly overlays: PrefixOverlaysService,
    private readonly summary: PrefixSummaryService,
    private readonly proposer: PrefixProposer,
  ) {}

  onApplicationBootstrap(): void {
    this.sinks.register(this);
  }

  async handle(runnerId: string, events: RunnerEvent[]): Promise<void> {
    for (const event of events) {
      if (
        event.type !== PREFIX_MEASURED_EVENT &&
        event.type !== PREFIX_OVERLAY_STALE_EVENT
      ) {
        continue;
      }
      const parsed = SCHEMAS[event.type].safeParse(event.data);
      const root = event.project?.root;
      if (!parsed.success || !root) {
        this.logger.warn(
          `runner ${runnerId}: malformed ${event.type} (seq ${event.seq}), skipped`,
        );
        continue;
      }
      const run = await this.prisma.run.findFirst({
        where: {
          id: parsed.data.runId,
          project: { runnerId, rootPath: root },
        },
        select: { id: true, projectId: true },
      });
      if (!run) {
        this.logger.warn(
          `runner ${runnerId}: ${event.type} (seq ${event.seq}) names no run of the project, dropped`,
        );
        continue;
      }
      if (event.type === PREFIX_MEASURED_EVENT) {
        await this.measured(run, parsed.data as PrefixMeasuredData);
      } else {
        const data = prefixOverlayStaleDataSchema.parse(event.data);
        await this.overlays.markStale(
          run.projectId,
          data.overlayId,
          data.sha256,
        );
      }
    }
  }

  private async measured(
    run: { id: string; projectId: string },
    data: PrefixMeasuredData,
  ): Promise<void> {
    const inserted = await this.prisma.runPrefixPart.createMany({
      data: data.parts.map((p) => ({
        runId: run.id,
        projectId: run.projectId,
        launchKind: data.launchKind,
        kind: p.kind,
        name: p.name,
        path: p.path,
        origin: p.origin,
        bytes: p.bytes,
        estTokens: p.estTokens,
        sha256: p.sha256,
      })),
      skipDuplicates: true,
    });
    if (inserted.count === 0) return;
    // QB2: an over-budget kind proposes for its largest repo part, once open.
    try {
      const part = await this.summary.overBudgetPart(
        run.projectId,
        data.launchKind,
      );
      if (part && this.proposer.enabled) {
        const open = await this.prisma.prefixOverlay.findFirst({
          where: {
            projectId: run.projectId,
            part,
            state: { in: ['proposed', 'approved'] },
          },
          select: { id: true },
        });
        if (!open) this.proposer.request(run.projectId, part, null, true);
      }
    } catch (error) {
      this.logger.warn(
        `project ${run.projectId}: auto-proposal check failed: ${(error as Error).message}`,
      );
    }
  }
}
