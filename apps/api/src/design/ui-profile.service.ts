import {
  DESIGN_ERROR,
  UIPROFILE_BUILD_TIMEOUT_SEC,
  type UiProfileRebuildResult,
  type UiProfileUpdateRequest,
  type UiProfileVersionsView,
  type UiProfileVersionView,
  type UiProfileView,
  uiProfileSnippetSchema,
} from '@agentdock/shared';
import { uiProfileBuildArgsSchema } from '@agentdock/shared/protocol';
import { Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { BudgetGate } from '../budgets/budget-gate';
import { PrismaService } from '../database/prisma.service';
import { type PlanProject, PlanStore } from '../planner/plan-store';
import type { PlanCaller } from '../planner/plan-turn.service';
import { plannerOutput } from '../planner/planner-commands';
import { PlannerFailure } from '../planner/planner-error';
import { DesignCommands } from './design-commands';
import { designError } from './design-error';
import { currentProfile, type Db, snippetsOf } from './design-store';
import { profilePreviewHtml } from './mockup-response';
import {
  type BuildArgs,
  type BuildReason,
  buildArgsOf,
  buildPrompt,
  obligationsOf,
  profileInclude,
  profileStatusOf,
  toProfileVersionSummary,
  toProfileVersionView,
  type WaitingDesign,
} from './ui-profile-mapper';

/** D18: a profile build runs on opus. */
const BUILD_MODEL = 'opus';
/** `runs.outcome`, as plan turns cut it. */
const OUTCOME_MAX = 500;

/** Where a design turn stands with the profile (D13). */
export type ProfileReadiness =
  | { kind: 'ready'; profileId: string | null }
  | { kind: 'building'; runId: string };

/** A `ui_profile` run's end → #21's run status. */
export const BUILD_RUN_STATUS = {
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'abandoned',
} as const;

/**
 * Ends a running build run once; `false` when it already ended.
 */
export const settleBuildRun = async (
  db: Db,
  runId: string,
  phase: keyof typeof BUILD_RUN_STATUS,
  outcome: string | null,
  at: Date = new Date(),
): Promise<boolean> => {
  const run = await db.run.findUnique({
    where: { id: runId },
    select: { startedAt: true, status: true },
  });
  if (!run || run.status !== 'running') return false;
  const updated = await db.run.updateMany({
    where: { id: runId, status: 'running' },
    data: {
      status: BUILD_RUN_STATUS[phase],
      outcome: outcome?.slice(0, OUTCOME_MAX) ?? null,
      endedAt: at,
      durationMs: Math.max(0, at.getTime() - run.startedAt.getTime()),
      updatedAt: new Date(),
    },
  });
  return updated.count > 0;
};

/**
 * The project's UI profile (docs/specs/223-design-stage.md D12–D14): read,
 * versions, a person's edit, and builds — on demand, first, or because the
 * files it was built from changed. The control plane never reads the
 * project's files (ADR-0001): the build and the fingerprint run on the
 * runner.
 */
@Injectable()
export class UiProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: PlanStore,
    private readonly commands: DesignCommands,
    private readonly audit: AuditService,
    @Optional() private readonly budgets?: BudgetGate,
  ) {}

  /** The newest `ui_profile` run of the project. */
  private latestBuild(projectId: string) {
    return this.prisma.run.findFirst({
      where: { projectId, kind: 'ui_profile' },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, status: true, args: true, startedAt: true },
    });
  }

  async view(projectId: string): Promise<UiProfileView> {
    const [current, build] = await Promise.all([
      this.prisma.uiProfile.findFirst({
        where: { projectId },
        orderBy: { version: 'desc' },
        include: profileInclude,
      }),
      this.latestBuild(projectId),
    ]);
    return {
      ...profileStatusOf(current, build),
      current: current ? toProfileVersionView(current) : null,
    };
  }

  async versions(projectId: string): Promise<UiProfileVersionsView> {
    const rows = await this.prisma.uiProfile.findMany({
      where: { projectId },
      orderBy: { version: 'desc' },
      include: profileInclude,
    });
    return { items: rows.map(toProfileVersionSummary) };
  }

  async version(
    projectId: string,
    version: number,
  ): Promise<UiProfileVersionView> {
    const row = await this.prisma.uiProfile.findUnique({
      where: { projectId_version: { projectId, version } },
      include: profileInclude,
    });
    if (!row) {
      throw designError(
        404,
        DESIGN_ERROR.notFound,
        'Profile version not found',
      );
    }
    return toProfileVersionView(row);
  }

  /**
   * Settings → Design's snippet preview: a version's kit and snippets on one
   * page — `version`, else the current one. 404 without a profile or with no
   * such version.
   */
  async previewHtml(projectId: string, version?: number): Promise<string> {
    const row =
      version !== undefined
        ? await this.prisma.uiProfile.findUnique({
            where: { projectId_version: { projectId, version } },
          })
        : await currentProfile(this.prisma, projectId);
    if (!row) {
      throw designError(
        404,
        DESIGN_ERROR.notFound,
        'Profile version not found',
      );
    }
    return profilePreviewHtml({
      version: row.version,
      kit: row.kit,
      snippets: snippetsOf(row.snippets),
    });
  }

  /**
   * D14: a project admin's edit is a new version, `source: manual`. It keeps
   * the fingerprint of the version it edits — the files did not change.
   */
  async update(
    projectId: string,
    caller: PlanCaller,
    request: UiProfileUpdateRequest,
  ): Promise<UiProfileVersionView> {
    const snippets = z
      .array(uiProfileSnippetSchema)
      .refine((ss) => new Set(ss.map((s) => s.name)).size === ss.length, {
        message: 'snippet names must be unique',
      })
      .safeParse(request.snippets);
    if (!snippets.success) {
      throw designError(
        400,
        DESIGN_ERROR.invalidArgs,
        z.prettifyError(snippets.error),
      );
    }
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`;
      const current = await currentProfile(tx, projectId);
      return tx.uiProfile.create({
        data: {
          projectId,
          version: (current?.version ?? 0) + 1,
          source: 'manual',
          hasUi: request.hasUi ?? current?.hasUi ?? true,
          summary: request.summary,
          kit: request.kit,
          snippets: snippets.data as Prisma.InputJsonValue,
          fingerprintGlobs: current?.fingerprintGlobs ?? [],
          fingerprint: current?.fingerprint ?? '',
          authorId: caller.userId,
        },
        include: profileInclude,
      });
    });
    await this.audit.record({
      ...caller.ctx,
      action: 'uiprofile.edited',
      target: { type: 'ui_profile', id: created.id },
      projectId,
      after: { version: created.version, hasUi: created.hasUi },
      result: 'ok',
    });
    return toProfileVersionView(created);
  }

  /** D13: **Rebuild** in settings — always a build, the fingerprint aside. */
  async rebuild(
    projectId: string,
    caller: PlanCaller,
  ): Promise<UiProfileRebuildResult> {
    const running = await this.latestBuild(projectId);
    if (running?.status === 'running') {
      throw designError(
        409,
        DESIGN_ERROR.designBusy,
        'A profile build is already running',
      );
    }
    const project = await this.store.project(projectId);
    return { runId: await this.startBuild(project, caller, 'rebuild', []) };
  }

  /**
   * D13: before a design turn. A build already running is joined; no profile
   * builds one; a profile whose files changed on `origin/<base>` rebuilds.
   * `waiting` is the design that starts once the build is done.
   */
  async ensureFresh(
    project: PlanProject,
    caller: PlanCaller,
    waiting: WaitingDesign,
  ): Promise<ProfileReadiness> {
    const build = await this.latestBuild(project.id);
    if (build?.status === 'running') {
      await this.join(build.id, waiting);
      return { kind: 'building', runId: build.id };
    }
    const profile = await currentProfile(this.prisma, project.id);
    if (!profile) {
      const runId = await this.startBuild(project, caller, 'first', [waiting]);
      return { kind: 'building', runId };
    }
    if (profile.fingerprintGlobs.length === 0) {
      return { kind: 'ready', profileId: profile.id };
    }
    const fingerprint = await this.fingerprint(
      project,
      profile.fingerprintGlobs,
      caller,
    );
    if (profile.fingerprint === '') {
      // The build could not take one (D13): this check is the first.
      await this.prisma.uiProfile.update({
        where: { id: profile.id },
        data: { fingerprint },
      });
      return { kind: 'ready', profileId: profile.id };
    }
    if (fingerprint === profile.fingerprint) {
      return { kind: 'ready', profileId: profile.id };
    }
    const runId = await this.startBuild(project, caller, 'stale', [waiting]);
    return { kind: 'building', runId };
  }

  /** `uiprofile.fingerprint` over `globs` at `origin/<base>`. */
  async fingerprint(
    project: PlanProject,
    globs: string[],
    caller: Pick<PlanCaller, 'role' | 'ctx'>,
  ): Promise<string> {
    const output = plannerOutput(
      'uiprofile.fingerprint',
      await this.commands.send(
        project.runnerId,
        'uiprofile.fingerprint',
        {
          projectId: project.id,
          root: project.rootPath,
          base: project.base,
          globs,
        },
        { role: caller.role, ctx: caller.ctx },
      ),
    );
    return output.fingerprint;
  }

  /** A design joins the build that is running. */
  private async join(runId: string, waiting: WaitingDesign): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM runs WHERE id = ${runId} FOR UPDATE`;
      const run = await tx.run.findUniqueOrThrow({
        where: { id: runId },
        select: { args: true },
      });
      const args = buildArgsOf(run.args);
      if (!args) return;
      const next: BuildArgs = {
        ...args,
        waiting: [
          ...args.waiting.filter((w) => w.designId !== waiting.designId),
          waiting,
        ],
      };
      await tx.run.update({
        where: { id: runId },
        data: { args: next as Prisma.InputJsonValue },
      });
    });
  }

  /**
   * Starts `uiprofile.build` (D13, D18): a `ui_profile` run on the project's
   * default profile and opus, refused by a budget like any run (#28). The
   * prompt carries the obligations of the manual versions since the last
   * agent build (D14).
   */
  private async startBuild(
    project: PlanProject,
    caller: PlanCaller,
    reason: BuildReason,
    waiting: WaitingDesign[],
  ): Promise<string> {
    const profile = await this.store.profile(project);
    this.commands.assertReady(project.runnerId, 'uiprofile.build');
    await this.budgets?.assertAllowed({
      projectId: project.id,
      userId: caller.userId,
    });
    const versions = await this.prisma.uiProfile.findMany({
      where: { projectId: project.id },
      orderBy: { version: 'asc' },
    });
    const obligations = obligationsOf(
      versions.map((v) => ({
        version: v.version,
        source: v.source,
        hasUi: v.hasUi,
        summary: v.summary,
        kit: v.kit,
        snippets: snippetsOf(v.snippets),
      })),
    );
    const prompt = buildPrompt(obligations);
    const draft = {
      projectId: project.id,
      root: project.rootPath,
      base: project.base,
      prompt,
      profileKey: profile.key,
      model: BUILD_MODEL,
      timeoutSec: UIPROFILE_BUILD_TIMEOUT_SEC,
    };
    const valid = uiProfileBuildArgsSchema.safeParse({
      ...draft,
      runId: 'pending',
    });
    if (!valid.success) {
      throw designError(
        400,
        DESIGN_ERROR.invalidArgs,
        z.prettifyError(valid.error),
      );
    }
    const args: BuildArgs = {
      projectId: project.id,
      reason,
      obligations,
      waiting,
    };
    const now = new Date();
    const run = await this.prisma.run.create({
      data: {
        kind: 'ui_profile',
        projectId: project.id,
        title: 'UI profile build',
        runtime: profile.runtime,
        model: BUILD_MODEL,
        profileKey: profile.key,
        args: args as Prisma.InputJsonValue,
        status: 'running',
        triggeredByType: 'user',
        triggeredById: caller.userId,
        startedAt: now,
        updatedAt: now,
      },
      select: { id: true },
    });
    await this.store.publishRun(project.id, run.id);
    try {
      plannerOutput(
        'uiprofile.build',
        await this.commands.send(
          project.runnerId,
          'uiprofile.build',
          { ...valid.data, runId: run.id },
          {
            role: caller.role,
            ctx: caller.ctx,
            // The prompt is data the audit log need not repeat in full.
            auditArgs: {
              ...valid.data,
              runId: run.id,
              prompt: `<${prompt.length} chars>`,
            },
          },
        ),
      );
    } catch (error) {
      // No answer: the runner may have started it; its events settle the run.
      if (
        error instanceof PlannerFailure &&
        error.code !== DESIGN_ERROR.runnerTimeout
      ) {
        await settleBuildRun(this.prisma, run.id, 'failed', error.message);
        await this.store.publishRun(project.id, run.id);
      }
      throw error;
    }
    return run.id;
  }
}
