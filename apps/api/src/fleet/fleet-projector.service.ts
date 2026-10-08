import { FLEET_LIVE_EVENT, type FleetLiveChange } from '@agentdock/shared';
import {
  type FleetEvent,
  parseFleetEvent,
  type RunnerEvent,
} from '@agentdock/shared/protocol';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { LiveService } from '../live/live.service';
import type { Applied } from './projection';
import {
  type OrchestratorEvent,
  type RoundEvent,
  RoundProjection,
} from './round-projection';
import { type SlotEvent, SlotProjection } from './slot-projection';

/** A projection change, for the live push on `project:<projectId>` (D9). */
export interface FleetChange extends FleetLiveChange {
  projectId: string;
}

/** A batch of 500 events is a few queries each; well under this. */
const TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * Turns a runner's fleet events into `rounds`, `slots`, `slot_checkpoints` and
 * `fleet_orchestrators` (spec 11 D8). Fed every incoming batch by the runner
 * event sink, before the batch is stored:
 * - data that does not fit is logged and skipped, never thrown;
 * - a database failure throws, which fails the batch so the runner resends;
 * - a resent or replayed event is a no-op (`lastSeq` on every row).
 */
@Injectable()
export class FleetProjector {
  private readonly logger = new Logger(FleetProjector.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
  ) {}

  /** Projects the batch, then publishes what changed. */
  async handle(runnerId: string, events: RunnerEvent[]): Promise<void> {
    const changes = await this.project(runnerId, events);
    for (const { projectId, kind, id } of changes) {
      const change: FleetLiveChange = { kind, id };
      this.live.publish(`project:${projectId}`, FLEET_LIVE_EVENT, change);
    }
  }

  /** Projects the batch in one transaction; returns the distinct changes. */
  async project(
    runnerId: string,
    events: RunnerEvent[],
  ): Promise<FleetChange[]> {
    const fleet = this.parse(events);
    if (fleet.length === 0) return [];

    const roots = [...new Set(fleet.map((e) => e.event.project.root))];
    const projects = new Map(
      (
        await this.prisma.project.findMany({
          where: { runnerId, rootPath: { in: roots } },
          select: { id: true, rootPath: true },
        })
      ).map((p) => [p.rootPath, p]),
    );

    const changes = new Map<string, FleetChange>();
    await this.prisma.$transaction(
      async (tx) => {
        // One projector per runner at a time, across API instances too.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`fleet:${runnerId}`}))`;
        for (const applied of fleet) {
          const project = projects.get(applied.event.project.root);
          if (!project) continue;
          const changed = (change: FleetLiveChange) =>
            changes.set(`${project.id}:${change.kind}:${change.id}`, {
              projectId: project.id,
              ...change,
            });
          await this.apply(
            new SlotProjection(tx, project, changed),
            new RoundProjection(tx, project, changed),
            applied,
          );
        }
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    return [...changes.values()];
  }

  private parse(
    events: RunnerEvent[],
  ): Applied<FleetEvent & { project: ProjectEnvelope }>[] {
    const fleet: Applied<FleetEvent & { project: ProjectEnvelope }>[] = [];
    for (const raw of events) {
      const parsed = parseFleetEvent(raw);
      if (!parsed) continue;
      if (!parsed.ok) {
        this.logger.warn(
          `skipped fleet event seq ${raw.seq}: ${parsed.reason}`,
        );
        continue;
      }
      const { event } = parsed;
      if (!event.project) {
        this.logger.warn(
          `skipped fleet event seq ${raw.seq}: ${event.type} without a project`,
        );
        continue;
      }
      fleet.push({
        event: event as FleetEvent & { project: ProjectEnvelope },
        ts: new Date(event.ts),
        seq: BigInt(event.seq),
      });
    }
    return fleet.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  }

  private async apply(
    slots: SlotProjection,
    rounds: RoundProjection,
    applied: Applied,
  ): Promise<void> {
    const { event } = applied;
    switch (event.type) {
      case 'round.started':
      case 'round.decided':
        return rounds.round(applied as Applied<RoundEvent>);
      case 'orchestrator.started':
      case 'orchestrator.stopped':
      case 'board.unparsed':
        return rounds.orchestrator(applied as Applied<OrchestratorEvent>);
      case 'pane.prompt':
      case 'pane.idle':
      case 'pane.quota_hit':
      case 'pane.busy':
        return event.data.target === 'orchestrator'
          ? rounds.orchestrator(applied as Applied<OrchestratorEvent>)
          : slots.apply(applied as Applied<SlotEvent>);
      case 'commit.trailer_found':
        // Kept in `events` only; nothing is projected from it yet.
        return;
      default:
        return slots.apply(applied as Applied<SlotEvent>);
    }
  }
}

type ProjectEnvelope = NonNullable<RunnerEvent['project']>;
