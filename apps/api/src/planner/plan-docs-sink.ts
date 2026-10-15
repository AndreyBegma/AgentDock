import {
  type PrClosedData,
  type PrMergedData,
  prClosedDataSchema,
  prMergedDataSchema,
  type RunnerEvent,
} from '@agentdock/shared/protocol';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Plan, PlanTask } from '@prisma/client';
import { SYSTEM_ACTOR, systemActorFor } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { readyLabelOf } from '../queue/queue-inputs';
import {
  type RunnerEventSink,
  RunnerEventSinks,
} from '../runners/runner-event-sinks';
import { PlanSendService } from './plan-send.service';
import { PlanStore } from './plan-store';
import { PlannerCommands, plannerOutput } from './planner-commands';
import { PlannerFailure } from './planner-error';
import { resolveSpecTarget } from './spec-target';

/** #379: how often a docs pull request in an external repository is checked. */
export const DOCS_PR_POLL_MS = 120_000;

type WaitingPlan = Pick<
  Plan,
  | 'id'
  | 'projectId'
  | 'version'
  | 'authorId'
  | 'docsPrNumber'
  | 'docsPrRepo'
  | 'designPrNumber'
  | 'docsPrMergedAt'
  | 'designPrMergedAt'
>;

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
 * D10 `docs_pr`: a sent plan's issues that wait for its docs pull request —
 * its features, and (spec 223 D16) every task with an approved design — are
 * queued when it merges. A `pr.closed` without `merged: true` (seen only leaving
 * the open list) is not a merge; the features then wait for a later signal.
 *
 * #379: with an external docs repository the plan has two pull requests —
 * the specs in the docs repository, the designs in the code repository —
 * and a task is queued once every one it waits on has merged. The runner's PR
 * collector watches only the code repository, so a docs-repository PR is
 * polled with `docs.pr_state`.
 */
@Injectable()
export class PlanDocsSink
  implements RunnerEventSink, OnModuleInit, OnModuleDestroy
{
  readonly name = 'planner-docs';
  private readonly logger = new Logger(PlanDocsSink.name);
  private timer: NodeJS.Timeout | undefined;
  private polling = false;

  constructor(
    private readonly sinks: RunnerEventSinks,
    private readonly prisma: PrismaService,
    private readonly store: PlanStore,
    private readonly send: PlanSendService,
    private readonly commands: PlannerCommands,
  ) {}

  onModuleInit(): void {
    this.sinks.register(this);
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      void this.pollDocsPrs().catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(`docs PR poll failed: ${reason}`);
      });
    }, DOCS_PR_POLL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async handle(runnerId: string, events: RunnerEvent[]): Promise<void> {
    for (const event of events) {
      const number = mergedPr(event);
      if (number === null || !event.project) continue;
      const project = { runnerId, rootPath: event.project.root };
      const docs = await this.prisma.plan.findMany({
        where: {
          docsPrNumber: number,
          docsPrRepo: null,
          status: 'sent',
          project,
        },
      });
      for (const plan of docs) {
        await this.merged(plan, { docsPrMergedAt: new Date() });
      }
      const designs = await this.prisma.plan.findMany({
        where: { designPrNumber: number, status: 'sent', project },
      });
      for (const plan of designs) {
        await this.merged(plan, { designPrMergedAt: new Date() });
      }
    }
  }

  /**
   * #379: one look at every sent plan whose docs pull request is in an
   * external docs repository and not seen merged yet.
   */
  async pollDocsPrs(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const plans = await this.prisma.plan.findMany({
        where: {
          status: 'sent',
          docsPrRepo: { not: null },
          docsPrNumber: { not: null },
          docsPrMergedAt: null,
        },
      });
      for (const plan of plans) {
        try {
          await this.pollOne(plan);
        } catch (error) {
          if (!(error instanceof PlannerFailure)) throw error;
          this.logger.warn(
            `plan ${plan.id}: docs PR state unknown: ${error.message}`,
          );
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollOne(plan: WaitingPlan): Promise<void> {
    if (plan.docsPrNumber === null) return;
    const project = await this.store.project(plan.projectId);
    const target = resolveSpecTarget(project);
    // The docs source changed since send: nothing to ask the runner about.
    if (target.kind !== 'docs_repo') return;
    const output = plannerOutput(
      'docs.pr_state',
      await this.commands.sendDocs(
        project.runnerId,
        'docs.pr_state',
        {
          projectId: project.id,
          root: project.rootPath,
          docsRoot: target.docsRoot,
          pr: plan.docsPrNumber,
        },
        { role: 'operator', ctx: { actor: SYSTEM_ACTOR } },
      ),
    );
    if (output.state === 'merged') {
      await this.merged(plan, { docsPrMergedAt: new Date() });
    }
  }

  private async merged(
    plan: WaitingPlan,
    data: { docsPrMergedAt?: Date; designPrMergedAt?: Date },
  ): Promise<void> {
    const updated = await this.prisma.plan.update({
      where: { id: plan.id },
      data,
    });
    await this.queueReady(updated);
  }

  private async queueReady(plan: WaitingPlan): Promise<void> {
    // Every issue send left unqueued is one that waits for a merge.
    const waiting = await this.prisma.planTask.findMany({
      where: {
        planId: plan.id,
        planVersion: plan.version,
        status: 'issued',
        issueNumber: { not: null },
        queuedAt: null,
      },
    });
    if (waiting.length === 0) return;
    const ready = await this.readyOf(plan, waiting);
    if (ready.length === 0) return;
    const project = await this.store.project(plan.projectId);
    try {
      const labelled = await this.send.queue(
        project,
        ready,
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

  /**
   * One docs PR in the code repository (D10): all of them. #379, two PRs:
   * every task waits on the docs PR, and one with an approved design on the
   * design PR too.
   */
  private async readyOf(
    plan: WaitingPlan,
    waiting: readonly PlanTask[],
  ): Promise<PlanTask[]> {
    if (plan.docsPrRepo === null && plan.designPrNumber === null) {
      return [...waiting];
    }
    const docsMerged =
      plan.docsPrNumber === null || plan.docsPrMergedAt !== null;
    if (!docsMerged) return [];
    const designMerged =
      plan.designPrNumber === null || plan.designPrMergedAt !== null;
    if (designMerged) return [...waiting];
    const designed = await this.prisma.taskDesign.findMany({
      where: { planId: plan.id, needed: true, status: 'approved' },
      select: { taskKey: true },
    });
    const keys = new Set(designed.map((d) => d.taskKey));
    return waiting.filter((t) => !keys.has(t.key));
  }
}
