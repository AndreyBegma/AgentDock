import {
  PLANNER_ERROR,
  PLANNER_LIVE_EVENT,
  type PlannerLiveChange,
  type PlanQuestion,
  RUN_UPDATED_LIVE_EVENT,
  type RunLiveChange,
} from '@agentdock/shared';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { LiveService } from '../live/live.service';
import { projectNotFound } from '../projects';
import { readablePlan } from './plan-access';
import { questionsOf } from './plan-mapper';
import { planNotFound, plannerError } from './planner-error';

type Db = Prisma.TransactionClient | PrismaService;

const TURN_ERROR_MAX = 2000;
/** `runs.outcome`, as skill runs cut it. */
const OUTCOME_MAX = 500;

/** A turn's end → #21's run status. */
const RUN_STATUS = {
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'abandoned',
} as const;

export interface TurnEnd {
  phase: keyof typeof RUN_STATUS;
  error?: string | null;
  resultText?: string | null;
  output?: Prisma.InputJsonValue;
  at?: Date;
}

/** What a turn or a send needs of the plan's project. */
export interface PlanProject {
  id: string;
  runnerId: string;
  rootPath: string;
  repo: string;
  /** `baseOverride` when set, else the detected base (#10). */
  base: string;
  defaultProfileId: string | null;
  readyLabelOverride: string | null;
  codeSentinelConfig: Prisma.JsonValue;
}

/** Reads shared by the planner services, and the one live push (spec "Live"). */
@Injectable()
export class PlanStore {
  private readonly logger = new Logger(PlanStore.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
  ) {}

  /** The plan, if `userId` may read it (D12); 404 otherwise. */
  async readable(userId: string, projectId: string, planId: string) {
    const plan = await this.prisma.plan.findFirst({
      where: readablePlan(userId, projectId, planId),
    });
    if (!plan) throw planNotFound();
    return plan;
  }

  /** The tasks of the plan's current version, in creation order. */
  currentTasks(db: Db, plan: { id: string; version: number }) {
    return db.planTask.findMany({
      where: { planId: plan.id, planVersion: plan.version },
      orderBy: [{ createdAt: 'asc' }, { key: 'asc' }],
    });
  }

  async task(plan: { id: string; version: number }, key: string) {
    const task = await this.prisma.planTask.findUnique({
      where: {
        planId_key_planVersion: {
          planId: plan.id,
          key,
          planVersion: plan.version,
        },
      },
    });
    if (!task) {
      throw plannerError(404, PLANNER_ERROR.notFound, 'Task not found');
    }
    return task;
  }

  /**
   * The plan-level round open now (D2 dialogue mode): the last succeeded
   * clarify's questions, unless it reported `done`.
   */
  async planRound(planId: string): Promise<PlanQuestion[]> {
    const last = await this.prisma.planTurn.findFirst({
      where: { planId, action: 'clarify', phase: 'succeeded' },
      orderBy: { createdAt: 'desc' },
      select: { output: true },
    });
    const output = last?.output;
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
      return [];
    }
    return output.done === true ? [] : questionsOf(output.questions ?? []);
  }

  async project(projectId: string): Promise<PlanProject> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        runnerId: true,
        rootPath: true,
        repo: true,
        baseBranch: true,
        baseOverride: true,
        defaultProfileId: true,
        readyLabelOverride: true,
        codeSentinelConfig: true,
      },
    });
    if (!project) throw projectNotFound();
    const { baseBranch, baseOverride, ...rest } = project;
    return { ...rest, base: baseOverride ?? baseBranch };
  }

  /**
   * The named profile, else the project's default (#10 D13, D14): on the
   * project runner, present, and `claude` — codex cannot plan.
   */
  async profile(project: PlanProject, key?: string) {
    const where = key
      ? { runnerId_key: { runnerId: project.runnerId, key } }
      : project.defaultProfileId
        ? { id: project.defaultProfileId }
        : null;
    if (!where) {
      throw plannerError(
        422,
        PLANNER_ERROR.noProfile,
        'Name a runtime profile, or set the project default',
      );
    }
    const profile = await this.prisma.runtimeProfile.findUnique({
      where,
      select: { key: true, runtime: true, runnerId: true, missing: true },
    });
    if (!profile || profile.runnerId !== project.runnerId || profile.missing) {
      throw plannerError(
        422,
        PLANNER_ERROR.unknownProfile,
        'The profile is not available on the project runner',
      );
    }
    if (profile.runtime !== 'claude') {
      throw plannerError(
        422,
        PLANNER_ERROR.unsupportedRuntime,
        `Plan turns need a claude profile; ${profile.key} is ${profile.runtime}`,
      );
    }
    return profile;
  }

  /** A sent or archived plan takes no more turns, reviews or revisions. */
  assertOpen(plan: { status: string }): void {
    if (plan.status === 'sent' || plan.status === 'archived') {
      throw plannerError(
        409,
        PLANNER_ERROR.planClosed,
        `The plan is ${plan.status}`,
      );
    }
  }

  /**
   * Ends a queued or running turn and its run (#21): once — a turn already
   * ended is left alone and `false` comes back.
   */
  async settleTurn(
    turnId: string,
    end: TurnEnd,
    db: Db = this.prisma,
  ): Promise<boolean> {
    const at = end.at ?? new Date();
    const updated = await db.planTurn.updateMany({
      where: { id: turnId, phase: { in: ['queued', 'running'] } },
      data: {
        phase: end.phase,
        error: end.error?.slice(0, TURN_ERROR_MAX) ?? null,
        ...(end.resultText !== undefined ? { resultText: end.resultText } : {}),
        ...(end.output !== undefined ? { output: end.output } : {}),
        finishedAt: at,
      },
    });
    if (updated.count === 0) return false;
    const { runId } = await db.planTurn.findUniqueOrThrow({
      where: { id: turnId },
      select: { runId: true },
    });
    const run = await db.run.findUniqueOrThrow({
      where: { id: runId },
      select: { startedAt: true },
    });
    await db.run.update({
      where: { id: runId },
      data: {
        status: RUN_STATUS[end.phase],
        outcome: end.error?.slice(0, OUTCOME_MAX) ?? null,
        endedAt: at,
        durationMs: Math.max(0, at.getTime() - run.startedAt.getTime()),
        updatedAt: new Date(),
      },
    });
    return true;
  }

  /** #21's `run.updated` for a turn's run, as skill runs publish it. Best effort. */
  async publishRun(projectId: string, runId: string): Promise<void> {
    const run = await this.prisma.run.findUnique({
      where: { id: runId },
      select: { id: true, status: true },
    });
    if (!run) return;
    try {
      this.live.publish(
        `project:${projectId}`,
        RUN_UPDATED_LIVE_EVENT,
        run satisfies RunLiveChange,
      );
    } catch (error) {
      this.logger.warn(
        `run ${runId} update not published: ${(error as Error).message}`,
      );
    }
  }

  /** Ids only: a client refetches, and the refetch is authorized. Best effort. */
  publish(projectId: string, planId: string): void {
    try {
      this.live.publish(`project:${projectId}`, PLANNER_LIVE_EVENT, {
        kind: 'planner',
        projectId,
        planId,
      } satisfies PlannerLiveChange);
    } catch (error) {
      this.logger.warn(
        `planner ${planId} update not published: ${(error as Error).message}`,
      );
    }
  }
}
