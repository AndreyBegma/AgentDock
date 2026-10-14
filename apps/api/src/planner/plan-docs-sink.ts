import {
  type PrClosedData,
  type PrMergedData,
  prClosedDataSchema,
  prMergedDataSchema,
  type RunnerEvent,
} from '@agentdock/shared/protocol';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { SYSTEM_ACTOR, systemActorFor } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { readyLabelOf } from '../queue/queue-inputs';
import {
  type RunnerEventSink,
  RunnerEventSinks,
} from '../runners/runner-event-sinks';
import { PlanSendService } from './plan-send.service';
import { PlanStore } from './plan-store';
import { PlannerFailure } from './planner-error';

/** A merge the runner saw: its PR poll (#11 `pr.closed`) or the orchestrator (`pr.merged`). */
const mergedPr = (event: RunnerEvent): number | null => {
  if (event.type === 'pr.closed') {
    const parsed = prClosedDataSchema.safeParse(event.data);
    return parsed.success && (parsed.data as PrClosedData).merged === true
      ? parsed.data.number
      : null;
  }
  if (event.type === 'pr.merged') {
    const parsed = prMergedDataSchema.safeParse(event.data);
    return parsed.success ? (parsed.data as PrMergedData).number : null;
  }
  return null;
};

/**
 * D10 `docs_pr`: a sent plan's feature issues are queued when its docs pull
 * request merges. A `pr.closed` without `merged: true` (seen only leaving
 * the open list) is not a merge; the features then wait for a later signal.
 */
@Injectable()
export class PlanDocsSink implements RunnerEventSink, OnModuleInit {
  readonly name = 'planner-docs';
  private readonly logger = new Logger(PlanDocsSink.name);

  constructor(
    private readonly sinks: RunnerEventSinks,
    private readonly prisma: PrismaService,
    private readonly store: PlanStore,
    private readonly send: PlanSendService,
  ) {}

  onModuleInit(): void {
    this.sinks.register(this);
  }

  async handle(runnerId: string, events: RunnerEvent[]): Promise<void> {
    for (const event of events) {
      const number = mergedPr(event);
      if (number === null || !event.project) continue;
      const plans = await this.prisma.plan.findMany({
        where: {
          docsPrNumber: number,
          status: 'sent',
          project: { runnerId, rootPath: event.project.root },
        },
      });
      for (const plan of plans) await this.queueFeatures(plan);
    }
  }

  private async queueFeatures(plan: {
    id: string;
    projectId: string;
    version: number;
    authorId: string | null;
  }): Promise<void> {
    const waiting = await this.prisma.planTask.findMany({
      where: {
        planId: plan.id,
        planVersion: plan.version,
        kind: 'feature',
        status: 'issued',
        issueNumber: { not: null },
        queuedAt: null,
      },
    });
    if (waiting.length === 0) return;
    const project = await this.store.project(plan.projectId);
    try {
      const labelled = await this.send.queue(
        project,
        waiting,
        readyLabelOf(project),
        {
          role: 'operator',
          ctx: {
            actor: plan.authorId ? systemActorFor(plan.authorId) : SYSTEM_ACTOR,
          },
        },
      );
      this.logger.log(
        `plan ${plan.id}: docs PR merged, queued ${labelled.join(', ')}`,
      );
      this.store.publish(plan.projectId, plan.id);
    } catch (error) {
      if (!(error instanceof PlannerFailure)) throw error;
      this.logger.warn(
        `plan ${plan.id}: docs PR merged, features not queued: ${error.message}`,
      );
    }
  }
}
