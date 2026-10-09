import {
  type AuditResult,
  type Role,
  RUN_UPDATED_LIVE_EVENT,
  type RunLiveChange,
  type RunTrigger,
  SKILLS_ERROR,
  type SkillRunDetail,
  type SkillRunRequest,
  type SkillRunView,
} from '@agentdock/shared';
import {
  isRunnableSkill,
  isTerminalSkillRunPhase,
  ORCHESTRATOR_DEFAULTS,
  SKILL_RUN_DEFAULT_TIMEOUT_SEC,
  type SkillRunArgs,
  skillRunArgsSchema,
} from '@agentdock/shared/protocol';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { BudgetGate } from '../budgets/budget-gate';
import { PrismaService } from '../database/prisma.service';
import { RunsQueryService } from '../history/runs-query.service';
import { LiveService } from '../live/live.service';
import { SkillCommands, skillOutput } from './skill-commands';
import {
  SkillInventoryService,
  type SkillProject,
} from './skill-inventory.service';
import { toSkillRunView } from './skill-mapper';
import { SkillsFailure, skillsError } from './skills-error';

/**
 * Who starts a run: a user from the run dialog, or a schedule (#25) or a
 * webhook (#26) acting with `role`. `id` is the user, schedule or hook id.
 */
export interface SkillRunTrigger {
  type: Exclude<RunTrigger, 'orchestrator'>;
  id: string | null;
  /** The effective project role the run is started with. */
  role: Role;
  ctx: AuditContext;
}

/** The caller of cancel. */
export interface SkillRunCaller {
  role: Role;
  ctx: AuditContext;
}

const runNotFound = () =>
  skillsError(404, SKILLS_ERROR.notFound, 'Skill run not found');

/**
 * Skill runs (spec 24 D7–D12). A run is a `runs` row of kind `skill` (#21)
 * plus its `skill_runs` row; the runner executes it and reports progress as
 * `skill_run.*` events, which `SkillRunProjector` applies.
 */
@Injectable()
export class SkillRunService {
  private readonly logger = new Logger(SkillRunService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: SkillCommands,
    private readonly inventory: SkillInventoryService,
    private readonly runs: RunsQueryService,
    private readonly live: LiveService,
    private readonly audit: AuditService,
    @Optional() private readonly budgets?: BudgetGate,
  ) {}

  /**
   * Starts `spec.skill` on the project. Everything that can be refused is
   * refused before a row exists or a command is sent: an orchestrator or
   * worker skill, a skill not in the inventory, a profile that is unknown or
   * `codex`, `bypassPermissions` without admin, an unwired or offline runner.
   * Exported for schedules (#25) and webhooks (#26).
   */
  async start(
    projectId: string,
    spec: SkillRunRequest,
    trigger: SkillRunTrigger,
  ): Promise<SkillRunView> {
    const project = await this.inventory.project(projectId);
    if (!isRunnableSkill(spec.skill)) {
      throw skillsError(
        422,
        SKILLS_ERROR.notRunnable,
        `${spec.skill} cannot run as a skill: it has its own control path`,
      );
    }
    if (!(await this.inventory.has(project, spec.skill))) {
      throw skillsError(
        404,
        SKILLS_ERROR.skillNotFound,
        `${spec.skill} is not installed for this project`,
      );
    }
    const profile = await this.profile(project, spec.profileKey);
    const permissionMode =
      spec.permissionMode ?? (await this.defaultPermissionMode(projectId));
    if (permissionMode === 'bypassPermissions' && trigger.role !== 'admin') {
      await this.record(trigger.ctx, 'denied', projectId, null, {
        skill: spec.skill,
        permissionMode,
      });
      throw skillsError(
        403,
        SKILLS_ERROR.forbidden,
        '`bypassPermissions` needs the admin role on the project',
      );
    }
    const draft = {
      projectId,
      root: project.rootPath,
      base: project.base,
      skill: spec.skill,
      args: spec.args,
      profileKey: profile.key,
      model: spec.model,
      permissionMode,
      output: spec.output,
      timeoutSec: spec.timeoutSec ?? SKILL_RUN_DEFAULT_TIMEOUT_SEC,
    };
    // The run id is not known yet; any valid id checks the rest.
    const valid = skillRunArgsSchema.safeParse({ ...draft, runId: 'pending' });
    if (!valid.success) {
      throw skillsError(
        400,
        SKILLS_ERROR.invalidArgs,
        z.prettifyError(valid.error),
      );
    }
    this.commands.assertReady(project.runnerId, 'skill.run');
    // Spec 28 D7, D11: an exceeded stop budget refuses with 409
    // `budget_exceeded`; only a person's run counts toward their budget (D3).
    await this.budgets?.assertAllowed({
      projectId,
      userId: trigger.type === 'user' ? trigger.id : null,
    });

    const now = new Date();
    const run = await this.prisma.run.create({
      data: {
        kind: 'skill',
        projectId,
        title: `/${spec.skill}`,
        runtime: profile.runtime,
        model: spec.model,
        profileKey: profile.key,
        args: { skill: spec.skill, args: spec.args },
        output: spec.output,
        status: 'running',
        triggeredByType: trigger.type,
        triggeredById: trigger.id,
        startedAt: now,
        updatedAt: now,
        skillRun: {
          create: {
            skill: spec.skill,
            args: spec.args,
            profileKey: profile.key,
            model: spec.model,
            permissionMode,
            output: spec.output,
            timeoutSec: draft.timeoutSec,
            queuedAt: now,
          },
        },
      },
      select: { id: true, status: true },
    });
    this.publish(projectId, run);
    const args: SkillRunArgs = { ...draft, runId: run.id };

    let failure: SkillsFailure;
    try {
      const output = skillOutput(
        'skill.run',
        await this.commands.send(project.runnerId, 'skill.run', args, {
          role: trigger.role,
          ctx: trigger.ctx,
        }),
      );
      // Events may already have moved it on; never step back.
      await this.prisma.skillRun.updateMany({
        where: { runId: run.id, phase: 'queued' },
        data: {
          phase: output.phase,
          ...(output.tmuxSession ? { tmuxSession: output.tmuxSession } : {}),
        },
      });
      await this.record(trigger.ctx, 'ok', projectId, run.id, {
        skill: spec.skill,
        profileKey: profile.key,
        model: spec.model,
        permissionMode,
        output: spec.output,
        timeoutSec: draft.timeoutSec,
        triggeredBy: trigger.type,
      });
      return this.view(projectId, run.id);
    } catch (error) {
      if (!(error instanceof SkillsFailure)) throw error;
      failure = error;
    }
    // No answer: the runner may have started it; its events settle the run.
    if (failure.code !== SKILLS_ERROR.runnerTimeout) {
      await this.fail(projectId, run.id, failure.message);
    }
    await this.record(trigger.ctx, 'error', projectId, run.id, {
      skill: spec.skill,
      error: failure.code,
    });
    throw failure.withRun(run.id);
  }

  /** D11: kills the run's session; the runner reports `cancelled`. */
  async cancel(
    projectId: string,
    runId: string,
    caller: SkillRunCaller,
  ): Promise<SkillRunView> {
    const row = await this.find(projectId, runId);
    if (isTerminalSkillRunPhase(row.phase)) {
      throw skillsError(
        409,
        SKILLS_ERROR.runFinished,
        `The run already ended ${row.phase}`,
      );
    }
    const runnerId = row.run.project.runnerId;
    try {
      const output = skillOutput(
        'skill.cancel',
        await this.commands.send(
          runnerId,
          'skill.cancel',
          { runId, projectId },
          caller,
        ),
      );
      await this.audit.record({
        ...caller.ctx,
        action: 'skill.run_cancelled',
        target: { type: 'run', id: runId },
        projectId,
        after: { skill: row.skill, cancelled: output.cancelled },
        result: 'ok',
      });
    } catch (error) {
      if (error instanceof SkillsFailure) {
        await this.audit.record({
          ...caller.ctx,
          action: 'skill.run_cancelled',
          target: { type: 'run', id: runId },
          projectId,
          after: { skill: row.skill },
          result: 'error',
          meta: { error: error.code },
        });
      }
      throw error;
    }
    return this.view(projectId, runId);
  }

  async detail(projectId: string, runId: string): Promise<SkillRunDetail> {
    const view = await this.view(projectId, runId);
    return { ...view, run: await this.runs.detail(projectId, runId) };
  }

  /** A run of this project, by id; another project's run is 404. */
  async view(projectId: string, runId: string): Promise<SkillRunView> {
    const row = await this.find(projectId, runId);
    return toSkillRunView(row, projectId);
  }

  private async find(projectId: string, runId: string) {
    const row = await this.prisma.skillRun.findFirst({
      where: { runId, run: { projectId, kind: 'skill' } },
      include: { run: { select: { project: { select: { runnerId: true } } } } },
    });
    if (!row) throw runNotFound();
    return row;
  }

  /** The request's profile, else the project's default (#10 D13): on its runner, present, `claude`. */
  private async profile(project: SkillProject, key: string | undefined) {
    const where = key
      ? { runnerId_key: { runnerId: project.runnerId, key } }
      : project.defaultProfileId
        ? { id: project.defaultProfileId }
        : null;
    if (!where) {
      throw skillsError(
        422,
        SKILLS_ERROR.noProfile,
        'Name a runtime profile, or set the project default',
      );
    }
    const profile = await this.prisma.runtimeProfile.findUnique({
      where,
      select: { key: true, runtime: true, runnerId: true, missing: true },
    });
    if (!profile || profile.runnerId !== project.runnerId || profile.missing) {
      throw skillsError(
        422,
        SKILLS_ERROR.unknownProfile,
        'The profile is not available on the project runner',
      );
    }
    if (profile.runtime !== 'claude') {
      throw skillsError(
        422,
        SKILLS_ERROR.unsupportedRuntime,
        `Skill runs need a claude profile; ${profile.key} is ${profile.runtime}`,
      );
    }
    return profile;
  }

  /** The project's orchestrator setting (#17 D3), else its default. */
  private async defaultPermissionMode(projectId: string) {
    const settings = await this.prisma.projectOrchestratorSettings.findUnique({
      where: { projectId },
      select: { permissionMode: true },
    });
    return settings?.permissionMode ?? ORCHESTRATOR_DEFAULTS.permissionMode;
  }

  /** The runner refused the run: it never started. */
  private async fail(
    projectId: string,
    runId: string,
    error: string,
  ): Promise<void> {
    const now = new Date();
    const run = await this.prisma.$transaction(async (tx) => {
      const run = await tx.run.findUniqueOrThrow({
        where: { id: runId },
        select: { startedAt: true },
      });
      await tx.skillRun.update({
        where: { runId },
        data: { phase: 'failed', error: error.slice(0, 500), finishedAt: now },
      });
      return tx.run.update({
        where: { id: runId },
        data: {
          status: 'failed',
          outcome: error.slice(0, 500),
          endedAt: now,
          durationMs: now.getTime() - run.startedAt.getTime(),
          updatedAt: now,
        },
        select: { id: true, status: true },
      });
    });
    this.publish(projectId, run);
  }

  private record(
    ctx: AuditContext,
    result: AuditResult,
    projectId: string,
    runId: string | null,
    after: object,
  ) {
    return this.audit.record({
      ...ctx,
      action: 'skill.run_started',
      target: { type: 'run', id: runId },
      projectId,
      after,
      result,
    });
  }

  private publish(projectId: string, change: RunLiveChange): void {
    try {
      this.live.publish(`project:${projectId}`, RUN_UPDATED_LIVE_EVENT, change);
    } catch (error) {
      this.logger.warn(
        `run.updated ${change.id} not published: ${(error as Error).message}`,
      );
    }
  }
}
