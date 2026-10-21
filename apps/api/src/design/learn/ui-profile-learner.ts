import { randomUUID } from 'node:crypto';
import {
  cardLabel,
  parseUiProfileLearnOutput,
  RUN_UPDATED_LIVE_EVENT,
  type RunLiveChange,
  stackLabel,
  UIPROFILE_LEARN_MODEL,
  UIPROFILE_LEARN_TIMEOUT_SEC,
} from '@nautelle/shared';
import {
  type UiProfileLearnArgs,
  uiProfileLearnArgsSchema,
} from '@nautelle/shared/protocol';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma, RunStatus } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { SYSTEM_ACTOR, systemActorFor } from '../../audit/audit.types';
import { BudgetGate } from '../../budgets/budget-gate';
import { PrismaService } from '../../database/prisma.service';
import { LiveService } from '../../live/live.service';
import { RuntimeProfileResolver } from '../../readiness';
import {
  currentProfile,
  designCommentsOf,
  revisionFrames,
  screensOf,
  snippetsOf,
  styleRulesOf,
} from '../design-store';
import { settleBuildRun } from '../ui-profile.service';
import { UiProfileLearnCommands } from './learn-commands';
import { applyLearn, buildLearnPrompt } from './learn-input';
import { type LearnJobData, UiProfileLearnQueue } from './learn-queue';

/** How one learn job ended. */
export type LearnOutcome =
  | { kind: 'skipped'; why: string }
  | { kind: 'failed'; runId: string; why: string }
  | { kind: 'learned'; runId: string; versionId: string };

const DESIGN_INCLUDE = {
  card: { select: { projectId: true, number: true, title: true } },
  stack: { select: { projectId: true, number: true, title: true } },
  plan: { select: { projectId: true } },
} as const;

/**
 * The UI profile's memory (docs/specs/752, ADR-0075 §6). After an approval
 * (A1) a `ui-profile-learn` job sends `uiprofile.learn` to the project's
 * runner (A2) with the approved frames, the profile's snippet names and the
 * design's comments — all from the database (ADR-0001). A valid answer
 * becomes a `memory` version under the project row lock (A3). Anything else
 * ends the `ui_profile_learn` run `failed` and stores nothing (A7). The
 * approval never waits on it and never fails because of it.
 */
@Injectable()
export class UiProfileLearner {
  private readonly logger = new Logger(UiProfileLearner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: UiProfileLearnQueue,
    private readonly commands: UiProfileLearnCommands,
    private readonly profiles: RuntimeProfileResolver,
    private readonly live: LiveService,
    private readonly audit: AuditService,
    @Optional() private readonly budgets?: BudgetGate,
  ) {}

  /** A1: queues the learn of an approved revision; never fails the approval. */
  async request(designId: string, revisionId: string): Promise<void> {
    try {
      await this.queue.add(designId, revisionId);
    } catch (error) {
      this.logger.warn(
        `design ${designId}: learn not queued: ${(error as Error).message}`,
      );
    }
  }

  /** One `ui-profile-learn` job. */
  async process(data: LearnJobData): Promise<LearnOutcome> {
    const design = await this.prisma.taskDesign.findUnique({
      where: { id: data.designId },
      include: {
        ...DESIGN_INCLUDE,
        approvedRevision: {
          select: { id: true, variant: true, title: true, rationale: true },
        },
      },
    });
    const revision = design?.approvedRevision;
    if (!design || !revision || revision.id !== data.revisionId) {
      return this.skip(data, 'the revision is no longer the approved one');
    }
    const projectId =
      design.card?.projectId ??
      design.stack?.projectId ??
      design.plan?.projectId;
    if (!projectId) return this.skip(data, 'no project');
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, runnerId: true, defaultProfileId: true },
    });
    if (!project) return this.skip(data, 'no project');

    // A2 (ADR-0023): only a runner that serves the command gets it.
    const state = this.commands.state(project.runnerId);
    if (state === 'offline') return this.skip(data, 'the runner is offline');
    if (state === 'unsupported') {
      return this.skip(data, 'the runner does not serve uiprofile.learn');
    }
    const current = await currentProfile(this.prisma, project.id);
    if (!current) return this.skip(data, 'the project has no UI profile');
    const pick = await this.profiles.resolve(project);
    if (!pick.ok || pick.profile.runtime !== 'claude') {
      return this.skip(data, 'no Claude runtime profile');
    }
    const budget = await this.budgets?.check({
      projectId: project.id,
      userId: design.approvedById,
    });
    if (budget && !budget.allowed) {
      return this.skip(data, `a ${budget.scope} budget stops new spend`);
    }

    const [frames, comments] = await Promise.all([
      revisionFrames(this.prisma, revision.id),
      designCommentsOf(this.prisma, design.id),
    ]);
    const prompt = buildLearnPrompt({
      subject: design.card
        ? `board card ${cardLabel(design.card.number)} "${design.card.title}"`
        : design.stack
          ? `stack ${stackLabel(design.stack.number)} "${design.stack.title}"`
          : `plan task \`${design.taskKey ?? '?'}\``,
      revisionTitle: revision.title,
      rationale: revision.rationale,
      frames: frames.map(({ name, html }) => ({ name, html })),
      snippetNames: snippetsOf(current.snippets).map((s) => s.name),
      comments,
    });
    if (!prompt) {
      return this.skip(data, 'the design is too large to learn from');
    }

    const now = new Date();
    const run = await this.prisma.run.create({
      data: {
        kind: 'ui_profile_learn',
        projectId: project.id,
        title: 'UI profile learning',
        runtime: 'claude',
        model: UIPROFILE_LEARN_MODEL,
        profileKey: pick.profile.key,
        args: { designId: design.id, revisionId: revision.id },
        status: 'running',
        triggeredByType: 'user',
        triggeredById: design.approvedById,
        startedAt: now,
        updatedAt: now,
      },
      select: { id: true },
    });
    this.publishRun(project.id, run.id, 'running');

    const args: UiProfileLearnArgs = uiProfileLearnArgsSchema.parse({
      runId: run.id,
      projectId: project.id,
      sessionId: randomUUID(),
      prompt,
      profileKey: pick.profile.key,
      model: UIPROFILE_LEARN_MODEL,
      timeoutSec: UIPROFILE_LEARN_TIMEOUT_SEC,
    });
    let text: string;
    try {
      const sent = await this.commands.learn(project.runnerId, args, {
        actor: design.approvedById
          ? systemActorFor(design.approvedById)
          : SYSTEM_ACTOR,
      });
      if (sent.status === 'unknown') {
        return this.fail(
          project.id,
          run.id,
          'the runner did not answer in time',
        );
      }
      if (sent.status === 'error') {
        return this.fail(project.id, run.id, `runner: ${sent.message}`);
      }
      if (sent.output.resultTruncated) {
        return this.fail(
          project.id,
          run.id,
          'contract_violation: result_truncated: the answer was cut',
        );
      }
      text = sent.output.resultText;
    } catch (error) {
      return this.fail(project.id, run.id, (error as Error).message);
    }
    const parsed = parseUiProfileLearnOutput(text);
    if (!parsed.ok) {
      return this.fail(
        project.id,
        run.id,
        `contract_violation: ${parsed.message}`,
      );
    }

    const commentIds = new Set(comments.map((c) => c.id));
    const approvedAt = design.approvedAt ?? now;
    const created = await this.prisma.$transaction(async (tx) => {
      // A3: under the project row lock, as a person's edit is written.
      await tx.$queryRaw`SELECT id FROM projects WHERE id = ${project.id} FOR UPDATE`;
      const base = await currentProfile(tx, project.id);
      if (!base) return null;
      const settled = await settleBuildRun(tx, run.id, 'succeeded', null);
      if (!settled) return null;
      const memory = applyLearn(
        {
          snippets: snippetsOf(base.snippets),
          screens: screensOf(base.screens),
          styleRules: styleRulesOf(base.styleRules),
        },
        parsed.output,
        {
          designId: design.id,
          revisionId: revision.id,
          approvedAt,
          commentIds,
        },
      );
      const row = await tx.uiProfile.create({
        data: {
          projectId: project.id,
          version: base.version + 1,
          source: 'memory',
          hasUi: base.hasUi,
          summary: base.summary,
          kit: base.kit,
          snippets: memory.snippets as Prisma.InputJsonValue,
          fingerprintGlobs: base.fingerprintGlobs,
          fingerprint: base.fingerprint,
          screens: memory.screens as Prisma.InputJsonValue,
          styleRules: memory.styleRules as Prisma.InputJsonValue,
          learnedFromRevisionId: revision.id,
          learnNotes: memory.learnNotes,
          runId: run.id,
        },
        select: { id: true, version: true },
      });
      return { ...row, dropped: memory.learnNotes !== null };
    });
    if (!created) {
      return this.fail(project.id, run.id, 'the profile is gone');
    }
    this.publishRun(project.id, run.id, 'succeeded');
    await this.audit.record({
      actor: design.approvedById
        ? systemActorFor(design.approvedById)
        : SYSTEM_ACTOR,
      action: 'uiprofile.built',
      target: { type: 'ui_profile', id: created.id },
      projectId: project.id,
      after: {
        version: created.version,
        source: 'memory',
        runId: run.id,
        designId: design.id,
        revisionId: revision.id,
        droppedSnippets: created.dropped,
      },
      result: 'ok',
    });
    return { kind: 'learned', runId: run.id, versionId: created.id };
  }

  private skip(data: LearnJobData, why: string): LearnOutcome {
    this.logger.log(`design ${data.designId}: not learned: ${why}`);
    return { kind: 'skipped', why };
  }

  /** A7: the run ends `failed`; nothing is stored. */
  private async fail(
    projectId: string,
    runId: string,
    why: string,
  ): Promise<LearnOutcome> {
    const settled = await settleBuildRun(this.prisma, runId, 'failed', why);
    if (settled) this.publishRun(projectId, runId, 'failed');
    this.logger.warn(`learn run ${runId} failed: ${why}`);
    return { kind: 'failed', runId, why };
  }

  private publishRun(projectId: string, runId: string, status: RunStatus) {
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
