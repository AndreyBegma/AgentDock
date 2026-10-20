import { randomUUID } from 'node:crypto';
import {
  RUN_UPDATED_LIVE_EVENT,
  type RunLiveChange,
  type StewardDigestItem,
  type StewardDigestTrigger,
} from '@nautelle/shared';
import {
  DIGEST_COMPOSE_ITEMS_MAX,
  DIGEST_COMPOSE_MODEL,
  type DigestComposeArgs,
  type DigestComposeSection,
  type StewardCommandName,
} from '@nautelle/shared/protocol';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { RunStatus } from '@prisma/client';
import { SYSTEM_ACTOR } from '../audit/audit.types';
import { BudgetGate } from '../budgets/budget-gate';
import { PrismaService } from '../database/prisma.service';
import { LiveService } from '../live/live.service';
import { RuntimeProfileResolver } from '../readiness';
import type { CommandSendResult } from '../runners/runner-command.service';
import { StewardCommands } from '../steward/steward-commands';
import type { DigestContent } from './steward-digest-composer';
import { boundedProse } from './steward-digest-format';
import { DIGEST_TITLE_MAX, oneLine } from './steward-digest-text';

const DIGEST_COMPOSE = 'digest.compose' satisfies StewardCommandName;
/** `runs.outcome` is short. */
const OUTCOME_MAX = 500;

/** The stored lines as `digest.compose` takes them: no url, at most the cap. */
const section = (items: StewardDigestItem[]): DigestComposeSection => ({
  total: items.length,
  items: items.slice(0, DIGEST_COMPOSE_ITEMS_MAX).map((item) => ({
    label: item.label || '-',
    title: item.title || '-',
    reason: item.reason || null,
  })),
});

/**
 * #491 (#447 D3, D14, D16): the digest prose, written by haiku on the
 * project's runner through `digest.compose`. Asked only when the runner is
 * connected, says `steward: true` and serves the command, the project has a
 * Claude profile and its budget allows it; the call is a `steward` run, so its
 * spend counts against the project budget. Every refusal or failure is
 * `null` — the digest is then the template — and never throws.
 *
 * The command takes the digest's stored, bounded content only (DA-12), and
 * its answer is stored through `boundedProse` (DA-13).
 */
@Injectable()
export class StewardDigestProse {
  private readonly logger = new Logger(StewardDigestProse.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: StewardCommands,
    private readonly profiles: RuntimeProfileResolver,
    private readonly live: LiveService,
    @Optional() private readonly budgets?: BudgetGate,
  ) {}

  async write(
    projectId: string,
    trigger: StewardDigestTrigger,
    content: DigestContent,
  ): Promise<string | null> {
    try {
      return await this.ask(projectId, trigger, content);
    } catch (error) {
      this.logger.warn(
        `digest prose of project ${projectId} not written: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private async ask(
    projectId: string,
    trigger: StewardDigestTrigger,
    content: DigestContent,
  ): Promise<string | null> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        runnerId: true,
        defaultProfileId: true,
        displayName: true,
      },
    });
    if (!project) return null;
    if (!(await this.commands.available(project.runnerId, DIGEST_COMPOSE))) {
      return null;
    }
    const pick = await this.profiles.resolve(project);
    if (!pick.ok || pick.profile.runtime !== 'claude') return null;
    const budget = await this.budgets?.check({ projectId, userId: null });
    if (budget && !budget.allowed) return null;

    const now = new Date();
    const run = await this.prisma.run.create({
      data: {
        kind: 'steward',
        projectId,
        title: 'Steward: digest prose',
        runtime: 'claude',
        model: DIGEST_COMPOSE_MODEL,
        profileKey: pick.profile.key,
        args: { digest: trigger },
        status: 'running',
        triggeredByType: 'orchestrator',
        startedAt: now,
        updatedAt: now,
      },
      select: { id: true },
    });
    this.publishRun(projectId, run.id, 'running');

    const args: DigestComposeArgs = {
      runId: run.id,
      projectId,
      sessionId: randomUUID(),
      profileKey: pick.profile.key,
      model: DIGEST_COMPOSE_MODEL,
      trigger,
      projectName: oneLine(project.displayName, DIGEST_TITLE_MAX) || 'Project',
      done: section(content.done),
      stuck: section(content.stuck),
      waiting: section(content.waiting),
      spendUsd: content.spendUsd,
    };
    let result: CommandSendResult<typeof DIGEST_COMPOSE>;
    try {
      result = await this.commands.send(
        project.runnerId,
        DIGEST_COMPOSE,
        args,
        {
          role: 'operator',
          ctx: { actor: SYSTEM_ACTOR },
          // The lines are card titles and reasons: counts only in the audit log.
          auditArgs: {
            runId: args.runId,
            projectId,
            trigger,
            done: args.done.total,
            stuck: args.stuck.total,
            waiting: args.waiting.total,
          },
        },
      );
    } catch (error) {
      await this.close(projectId, run.id, 'failed', (error as Error).message);
      return null;
    }
    if (result.status !== 'ok') {
      const why =
        result.status === 'error'
          ? `runner: ${result.error.code}${result.error.message ? ` — ${result.error.message}` : ''}`
          : 'no answer from the runner';
      await this.close(projectId, run.id, 'failed', why);
      return null;
    }
    const prose = boundedProse(result.output.prose);
    await this.close(
      projectId,
      run.id,
      prose ? 'succeeded' : 'failed',
      prose ? 'digest prose written' : 'contract_violation: empty prose',
    );
    return prose;
  }

  private async close(
    projectId: string,
    runId: string,
    status: RunStatus,
    outcome: string,
  ): Promise<void> {
    const now = new Date();
    const run = await this.prisma.run.findUnique({
      where: { id: runId },
      select: { startedAt: true },
    });
    const { count } = await this.prisma.run.updateMany({
      where: { id: runId, endedAt: null },
      data: {
        status,
        endedAt: now,
        durationMs: run ? now.getTime() - run.startedAt.getTime() : 0,
        updatedAt: now,
        outcome: outcome.slice(0, OUTCOME_MAX),
      },
    });
    if (count > 0) this.publishRun(projectId, runId, status);
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
