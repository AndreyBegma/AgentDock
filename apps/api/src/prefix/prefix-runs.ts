import { randomUUID } from 'node:crypto';
import { RUN_UPDATED_LIVE_EVENT, type RunLiveChange } from '@nautelle/shared';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma, RunStatus } from '@prisma/client';
import type { AuditContext } from '../audit/audit.types';
import { SYSTEM_ACTOR, systemActorFor } from '../audit/audit.types';
import { BudgetGate } from '../budgets/budget-gate';
import { PrismaService } from '../database/prisma.service';
import { settleBuildRun } from '../design/ui-profile.service';
import { LiveService } from '../live/live.service';
import { RuntimeProfileResolver } from '../readiness';
import { type PrefixCommandState, PrefixCommands } from './prefix-commands';

/** How one compression or proposal job ended. */
export type PrefixJobOutcome =
  | { kind: 'skipped'; why: string }
  | { kind: 'failed'; runId: string; why: string }
  | { kind: 'stored'; runId: string; overlayId: string };

export interface PrefixJobProject {
  id: string;
  runnerId: string;
  rootPath: string;
  defaultProfileId: string | null;
}

export type PrefixRunStart =
  | { ok: false; why: string }
  | {
      ok: true;
      runId: string;
      sessionId: string;
      profileKey: string;
      ctx: AuditContext;
    };

/**
 * The `rules_compress` and `prefix_propose` runs (#751 B6, B8): the gates a
 * job passes before it spends — the runner serves the command (ADR-0023), a
 * Claude profile, the budget — then the run row, priced by its session
 * (ADR-0009), and its settlement, as the UI profile's learn runs are.
 */
@Injectable()
export class PrefixRuns {
  private readonly logger = new Logger(PrefixRuns.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: PrefixCommands,
    private readonly profiles: RuntimeProfileResolver,
    private readonly live: LiveService,
    @Optional() private readonly budgets?: BudgetGate,
  ) {}

  async project(projectId: string): Promise<PrefixJobProject | null> {
    return this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        runnerId: true,
        rootPath: true,
        defaultProfileId: true,
      },
    });
  }

  state(
    project: PrefixJobProject,
    name: 'rules.compress' | 'prefix.propose',
  ): PrefixCommandState {
    return this.commands.state(project.runnerId, name);
  }

  async start(
    project: PrefixJobProject,
    run: {
      kind: 'rules_compress' | 'prefix_propose';
      name: 'rules.compress' | 'prefix.propose';
      title: string;
      model: string;
      args: Prisma.InputJsonValue;
      userId: string | null;
    },
  ): Promise<PrefixRunStart> {
    const state = this.state(project, run.name);
    if (state === 'offline') return { ok: false, why: 'the runner is offline' };
    if (state === 'unsupported') {
      return { ok: false, why: `the runner does not serve ${run.name}` };
    }
    const pick = await this.profiles.resolve(project);
    if (!pick.ok || pick.profile.runtime !== 'claude') {
      return { ok: false, why: 'no Claude runtime profile' };
    }
    const budget = await this.budgets?.check({
      projectId: project.id,
      userId: run.userId,
    });
    if (budget && !budget.allowed) {
      return { ok: false, why: `a ${budget.scope} budget stops new spend` };
    }
    const now = new Date();
    const row = await this.prisma.run.create({
      data: {
        kind: run.kind,
        projectId: project.id,
        title: run.title,
        runtime: 'claude',
        model: run.model,
        profileKey: pick.profile.key,
        args: run.args,
        status: 'running',
        triggeredByType: 'user',
        triggeredById: run.userId,
        startedAt: now,
        updatedAt: now,
      },
      select: { id: true },
    });
    this.publish(project.id, row.id, 'running');
    return {
      ok: true,
      runId: row.id,
      sessionId: randomUUID(),
      profileKey: pick.profile.key,
      ctx: { actor: run.userId ? systemActorFor(run.userId) : SYSTEM_ACTOR },
    };
  }

  async succeed(
    db: Prisma.TransactionClient,
    projectId: string,
    runId: string,
  ): Promise<boolean> {
    const settled = await settleBuildRun(db, runId, 'succeeded', null);
    if (settled) this.publish(projectId, runId, 'succeeded');
    return settled;
  }

  async fail(
    projectId: string,
    runId: string,
    why: string,
  ): Promise<PrefixJobOutcome> {
    const settled = await settleBuildRun(this.prisma, runId, 'failed', why);
    if (settled) this.publish(projectId, runId, 'failed');
    this.logger.warn(`prefix run ${runId} failed: ${why}`);
    return { kind: 'failed', runId, why };
  }

  skip(subject: string, why: string): PrefixJobOutcome {
    this.logger.log(`${subject}: skipped: ${why}`);
    return { kind: 'skipped', why };
  }

  private publish(projectId: string, runId: string, status: RunStatus) {
    const change: RunLiveChange = { id: runId, status };
    try {
      this.live.publish(`project:${projectId}`, RUN_UPDATED_LIVE_EVENT, change);
    } catch (error) {
      this.logger.warn(
        `run.updated ${runId} not published: ${(error as Error).message}`,
      );
    }
  }
}
