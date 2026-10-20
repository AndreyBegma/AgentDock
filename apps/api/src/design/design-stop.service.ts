import { DESIGN_ERROR, type DesignProgressStage } from '@nautelle/shared';
import { Injectable, Logger } from '@nestjs/common';
import type { Plan } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { cardNotFound } from '../board/board-error';
import { PrismaService } from '../database/prisma.service';
import type { PlanActor } from '../planner/plan.service';
import { PlanStore } from '../planner/plan-store';
import {
  PlannerCommands,
  plannerFailureOf,
  plannerOutput,
} from '../planner/planner-commands';
import { settleDesign } from './design-apply';
import { DesignCommands } from './design-commands';
import { designError } from './design-error';
import { buildsHoldingWhere, designTurnWhere } from './design-progress';
import { designTurnPlanOf } from './design-rules';
import { type DesignKey, designWhere } from './design-store';
import { type BuildArgs, buildArgsOf } from './ui-profile-mapper';

/** What Stop needs of a design's owner (ADR-0025). */
interface StopOwner {
  key: DesignKey;
  projectId: string;
  /** The `planId` its turns run under on the runner: the plan's, the card's or the stack's. */
  hostId: string;
  target: { type: 'plan' | 'board_card' | 'board_stack'; id: string };
  label: { key: string } | { number: number } | { stack: number };
  publish(): void;
}

const notRunning = () =>
  designError(
    409,
    DESIGN_ERROR.designNotRunning,
    'No profile build or design turn of this design is running',
  );

/**
 * #275 D5: Stop a busy design, for both owners. On the draw or revise stage
 * the design turn is cancelled (`plan.cancel`) and the projector settles the
 * design when the runner reports it. On the profile stage the design leaves
 * the build's `args.waiting` and rests at once; the build itself is cancelled
 * (`uiprofile.cancel`) only when no other design waits for it and it is not
 * an admin's Rebuild — one person's Stop never kills another's wait. A busy
 * design with neither a turn nor a build rests at once (#606).
 */
@Injectable()
export class DesignStopService {
  private readonly logger = new Logger(DesignStopService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: PlanStore,
    private readonly planner: PlannerCommands,
    private readonly commands: DesignCommands,
    private readonly audit: AuditService,
  ) {}

  /** `POST …/tasks/:key/design/stop`, once the plan is known readable. */
  stop(plan: Plan, taskKey: string, actor: PlanActor): Promise<void> {
    return this.stopOf(
      {
        key: { planId: plan.id, taskKey },
        projectId: plan.projectId,
        hostId: plan.id,
        target: { type: 'plan', id: plan.id },
        label: { key: taskKey },
        publish: () =>
          this.store.publishDesign(plan.projectId, plan.id, taskKey),
      },
      actor,
    );
  }

  /** `POST …/board/cards/:number/design/stop`. */
  async cardStop(
    projectId: string,
    number: number,
    actor: PlanActor,
  ): Promise<void> {
    const card = await this.prisma.boardCard.findUnique({
      where: { projectId_number: { projectId, number } },
      select: { id: true },
    });
    if (!card) throw cardNotFound();
    await this.stopOf(
      {
        key: { cardId: card.id },
        projectId,
        hostId: card.id,
        target: { type: 'board_card', id: card.id },
        label: { number },
        publish: () => this.store.publishCardDesign(projectId, card.id),
      },
      actor,
    );
  }

  /** `POST …/board/stacks/:number/design/stop` (#480). */
  async stackStop(
    projectId: string,
    number: number,
    actor: PlanActor,
  ): Promise<void> {
    const stack = await this.prisma.boardStack.findUnique({
      where: { projectId_number: { projectId, number } },
      select: { id: true },
    });
    if (!stack) {
      throw designError(404, DESIGN_ERROR.notFound, 'Stack not found');
    }
    await this.stopOf(
      {
        key: { stackId: stack.id },
        projectId,
        hostId: stack.id,
        target: { type: 'board_stack', id: stack.id },
        label: { stack: number },
        publish: () => this.store.publishStackDesign(projectId, stack.id),
      },
      actor,
    );
  }

  private async stopOf(owner: StopOwner, actor: PlanActor): Promise<void> {
    const design = await this.prisma.taskDesign.findUnique({
      where: designWhere(owner.key),
      select: { id: true, status: true },
    });
    if (!design) {
      throw designError(404, DESIGN_ERROR.notFound, 'Design not found');
    }
    if (design.status !== 'generating' && design.status !== 'revising') {
      throw notRunning();
    }
    const project = await this.store.project(owner.projectId);
    const caller = { role: actor.role, ctx: actor.ctx };

    const turn = await this.prisma.planTurn.findFirst({
      where: {
        ...designTurnWhere(owner.key),
        phase: { in: ['queued', 'running'] },
      },
      select: { id: true, runId: true, run: { select: { args: true } } },
    });
    if (turn) {
      plannerOutput(
        'plan.cancel',
        await this.planner.send(
          project.runnerId,
          'plan.cancel',
          { planId: owner.hostId, turnId: turn.id },
          caller,
        ),
      );
      const stage: DesignProgressStage =
        designTurnPlanOf(turn.run.args)?.mode === 'revise' ? 'revise' : 'draw';
      await this.stopped(owner, actor, {
        stage,
        runId: turn.runId,
        turnId: turn.id,
      });
      return;
    }

    const build = await this.prisma.run.findFirst({
      where: {
        ...buildsHoldingWhere(owner.projectId, design.id),
        status: 'running',
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, args: true },
    });
    if (!build) {
      // Busy with nothing running: a batch whose next turn never started
      // (the API stopped between two). Stop puts it back to rest, or it
      // would refuse Generate as busy and Stop as not running forever.
      await settleDesign(this.prisma, owner.key);
      await this.stopped(owner, actor, { stage: null });
      return;
    }
    // Nothing is written when the build would need a cancel the runner
    // cannot take (#233).
    if (this.cancelsBuild(buildArgsOf(build.args), design.id)) {
      this.commands.assertServed(project.runnerId, ['uiprofile.cancel']);
    }
    const cancel = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM runs WHERE id = ${build.id} FOR UPDATE`;
      const run = await tx.run.findUniqueOrThrow({
        where: { id: build.id },
        select: { status: true, args: true },
      });
      const args = buildArgsOf(run.args);
      // The build ended between the read and the lock: its end settled the
      // design or started its first turn, which a second Stop cancels.
      if (run.status !== 'running' || !args) throw notRunning();
      const cancels = this.cancelsBuild(args, design.id);
      const next: BuildArgs = {
        ...args,
        waiting: args.waiting.filter((w) => w.designId !== design.id),
      };
      await tx.run.update({
        where: { id: build.id },
        data: { args: next, updatedAt: new Date() },
      });
      await settleDesign(tx, owner.key);
      return cancels;
    });
    if (cancel) await this.cancelBuild(project.runnerId, build.id, caller);
    await this.stopped(owner, actor, { stage: 'profile', runId: build.id });
  }

  /** D5: this design is the build's only waiter, and no Rebuild asked for it. */
  private cancelsBuild(args: BuildArgs | null, designId: string): boolean {
    if (!args || args.reason === 'rebuild') return false;
    return args.waiting.every((w) => w.designId === designId);
  }

  /**
   * `uiprofile.cancel`, best effort: the design already rests. A build the
   * runner does not cancel runs to its end with nobody waiting for it.
   */
  private async cancelBuild(
    runnerId: string,
    runId: string,
    caller: Pick<PlanActor, 'role' | 'ctx'>,
  ): Promise<void> {
    const result = await this.commands.send(
      runnerId,
      'uiprofile.cancel',
      { runId },
      caller,
    );
    if (result.status === 'error') {
      const failure = plannerFailureOf('uiprofile.cancel', result.error);
      this.logger.warn(`build ${runId}: ${failure.message}`);
    } else if (result.status !== 'ok') {
      this.logger.warn(`build ${runId}: uiprofile.cancel ${result.status}`);
    }
  }

  private async stopped(
    owner: StopOwner,
    actor: PlanActor,
    /** `stage` null: nothing was running. */
    meta: {
      stage: DesignProgressStage | null;
      runId?: string;
      turnId?: string;
    },
  ): Promise<void> {
    await this.audit.record({
      ...actor.ctx,
      action: 'design.stopped',
      target: owner.target,
      projectId: owner.projectId,
      after: { ...owner.label, ...meta },
      result: 'ok',
    });
    owner.publish();
  }
}
