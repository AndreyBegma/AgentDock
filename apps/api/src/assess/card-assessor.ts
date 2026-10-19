import { randomUUID } from 'node:crypto';
import {
  BOARD_CHANGED_EVENT,
  type BoardCardKind,
  type BoardChangedData,
  CARD_ASSESS_MAX_RUNNING_PER_PROJECT,
  CARD_ASSESS_MODEL,
  CARD_ASSESS_TIMEOUT_SEC,
  cardLabel,
  isActiveRoundPhase,
  RUN_UPDATED_LIVE_EVENT,
  type RunLiveChange,
} from '@agentdock/shared';
import type {
  CardAssessArgs,
  CardAssessFinishedData,
} from '@agentdock/shared/protocol';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma, RunStatus } from '@prisma/client';
import { z } from 'zod';
import { BudgetGate } from '../budgets/budget-gate';
import { PrismaService } from '../database/prisma.service';
import { LiveService } from '../live/live.service';
import { RuntimeProfileResolver } from '../readiness';
import { TokenSaverService } from '../token-saver/token-saver.service';
import { AssessCommands } from './assess-commands';
import {
  buildCardAssessPrompt,
  type CardAssessInput,
  cardAssessHash,
  parseCardAssessOutput,
} from './assess-input';
import { type AssessJobData, AssessQueue } from './assess-queue';

type Tx = Prisma.TransactionClient;

/** A running assessment with no result this long after it started failed. */
export const ASSESS_STALE_MS = (CARD_ASSESS_TIMEOUT_SEC + 10 * 60) * 1000;
/** `CARD_ASSESS_MAX_RUNNING_PER_PROJECT` are running: look again this much later. */
const BUSY_RETRY_MS = 30_000;
/** D8: a round of the card is active: look again this much later. */
const ROUND_RETRY_MS = 5 * 60_000;
/** `runs.outcome` is short. */
const OUTCOME_MAX = 500;

/** What one job did; the worker turns `deferred` into a delayed job. */
export type AssessOutcome =
  | { kind: 'none'; why: string }
  | { kind: 'deferred'; untilMs: number; why: 'busy' | 'round_active' }
  | { kind: 'started'; runId: string };

/** `runs.args` of a `card_assess` run. */
const runArgsSchema = z.object({ cardId: z.string(), hash: z.string() });

const CARD_SELECT = {
  id: true,
  number: true,
  projectId: true,
  title: true,
  body: true,
  kind: true,
  column: true,
  assessmentHash: true,
  assessRunId: true,
} as const;

interface AssessedCard {
  card: Prisma.BoardCardGetPayload<{ select: typeof CARD_SELECT }>;
  input: CardAssessInput;
  hash: string;
  roundActive: boolean;
}

/**
 * A card's model recommendation (issue #322 D5–D8, ADR-0032): a `haiku`
 * call on the project's runner (`card.assess`, a `runs` row of kind
 * `card_assess`) recommends a model for the card's work and for its design.
 * It is asked once the save's normalization settled, never holds a save or a
 * launch, and its answer applies only while the card still hashes to what
 * was asked (ADR-0027 D4).
 */
@Injectable()
export class CardAssessor {
  private readonly logger = new Logger(CardAssessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: AssessCommands,
    private readonly queue: AssessQueue,
    private readonly live: LiveService,
    private readonly profiles: RuntimeProfileResolver,
    private readonly tokenSaver: TokenSaverService,
    @Optional() private readonly budgets?: BudgetGate,
  ) {}

  /**
   * D6: queues the card's assessment when its input moved since the last
   * applied one and no call is asking it already. Called by the board after
   * a save and once the save's normalization settled; never fails it.
   */
  async request(cardId: string): Promise<void> {
    try {
      if (!this.queue.enabled) return;
      const found = await this.read(this.prisma, cardId);
      if (!found || found.card.assessmentHash === found.hash) return;
      if (await this.asking(this.prisma, found.card.assessRunId, found.hash)) {
        return;
      }
      await this.queue.add(cardId, found.hash);
    } catch (error) {
      this.logger.warn(
        `card ${cardId}: assessment not requested: ${(error as Error).message}`,
      );
    }
  }

  /** One `card-assess` job (D6–D8). */
  async process(
    data: AssessJobData,
    now: Date = new Date(),
  ): Promise<AssessOutcome> {
    const found = await this.read(this.prisma, data.cardId);
    if (!found) return { kind: 'none', why: 'no card' };
    const { card, hash } = found;
    // A newer save queued its own job.
    if (hash !== data.hash) return { kind: 'none', why: 'input moved' };
    if (card.assessmentHash === hash) return { kind: 'none', why: 'assessed' };
    if (card.column === 'completed' || card.column === 'inbox') {
      return { kind: 'none', why: card.column };
    }
    // The English text is still coming; its settled hook asks again.
    if (await this.normalizing(card.id)) {
      return { kind: 'none', why: 'normalizing' };
    }
    if (found.roundActive) {
      return {
        kind: 'deferred',
        untilMs: now.getTime() + ROUND_RETRY_MS,
        why: 'round_active',
      };
    }

    const project = await this.prisma.project.findUnique({
      where: { id: card.projectId },
      select: { id: true, runnerId: true, defaultProfileId: true },
    });
    if (!project) return { kind: 'none', why: 'no project' };
    await this.giveUpStale(project.id, now);

    // D7: without a runner that serves it, a Claude profile or budget, the
    // card simply has no recommendation.
    const state = this.commands.state(project.runnerId);
    if (state !== 'ready') return { kind: 'none', why: `runner ${state}` };
    const pick = await this.profiles.resolve(project);
    if (!pick.ok || pick.profile.runtime !== 'claude') {
      return { kind: 'none', why: 'no_profile' };
    }
    const budget = await this.budgets?.check({
      projectId: project.id,
      userId: null,
    });
    if (budget && !budget.allowed) {
      return { kind: 'none', why: 'budget_exceeded' };
    }

    let prompt: string;
    try {
      prompt = buildCardAssessPrompt(found.input);
    } catch (error) {
      return { kind: 'none', why: (error as Error).message };
    }
    const sessionId = randomUUID();
    // #445 D11: only a runner that advertises the token saver gets the field.
    const saver = await this.tokenSaver.launch(project.id);
    const runId = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`card-assess:${project.id}`}))`;
      const fresh = await this.read(tx, card.id);
      if (
        !fresh ||
        fresh.hash !== hash ||
        (await this.asking(tx, fresh.card.assessRunId, hash))
      ) {
        return undefined;
      }
      if (await this.busy(project.id, tx)) return null;
      const run = await tx.run.create({
        data: {
          kind: 'card_assess',
          projectId: project.id,
          title: `Model assessment · ${cardLabel(card.number)}`,
          runtime: 'claude',
          model: CARD_ASSESS_MODEL,
          profileKey: pick.profile.key,
          args: { cardId: card.id, hash },
          tokenSaver: saver.on,
          status: 'running',
          triggeredByType: 'user',
          triggeredById: null,
          startedAt: now,
          updatedAt: now,
        },
        select: { id: true },
      });
      await tx.boardCard.update({
        where: { id: card.id },
        data: { assessRunId: run.id },
      });
      return run.id;
    });
    if (runId === undefined) return { kind: 'none', why: 'asked already' };
    if (runId === null) {
      return {
        kind: 'deferred',
        untilMs: now.getTime() + BUSY_RETRY_MS,
        why: 'busy',
      };
    }
    this.publishRun(project.id, runId, 'running');

    const args: CardAssessArgs = {
      runId,
      projectId: project.id,
      sessionId,
      prompt,
      profileKey: pick.profile.key,
      model: CARD_ASSESS_MODEL,
      timeoutSec: CARD_ASSESS_TIMEOUT_SEC,
      ...saver.args,
    };
    let sent: Awaited<ReturnType<AssessCommands['assess']>>;
    try {
      sent = await this.commands.assess(project.runnerId, args);
    } catch (error) {
      sent = { status: 'error', message: (error as Error).message };
    }
    if (sent.status === 'error') {
      await this.fail(project.id, runId, `runner: ${sent.message}`);
      return { kind: 'none', why: 'run_failed' };
    }
    // `unknown`: the runner may have started it; its event, or the stale
    // sweep, settles it.
    return { kind: 'started', runId };
  }

  /**
   * `card_assess.finished` from `runnerId` (D6, D7). Applied once: only a
   * running `card_assess` run of that runner's project is touched.
   */
  async finished(
    runnerId: string,
    data: CardAssessFinishedData,
  ): Promise<void> {
    const run = await this.prisma.run.findFirst({
      where: {
        id: data.runId,
        projectId: data.projectId,
        kind: 'card_assess',
        project: { runnerId },
      },
      select: { id: true, status: true, args: true, projectId: true },
    });
    if (!run || run.status !== 'running') return;
    const args = runArgsSchema.safeParse(run.args);
    if (!args.success) {
      await this.fail(run.projectId, run.id, 'run args unreadable');
      return;
    }
    if (!data.ok) {
      await this.fail(
        run.projectId,
        run.id,
        `runner: ${data.error ?? 'failed'}`,
      );
      return;
    }
    if (data.resultTruncated) {
      await this.fail(
        run.projectId,
        run.id,
        'contract_violation: truncated — the result was cut at its limit',
      );
      return;
    }
    const parsed = parseCardAssessOutput(data.result ?? '');
    if (!parsed.ok) {
      await this.fail(
        run.projectId,
        run.id,
        `contract_violation: ${parsed.error}`,
      );
      return;
    }
    const { work, design } = parsed.answer;
    const { cardId, hash } = args.data;
    const ended = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM board_cards WHERE id = ${cardId} FOR UPDATE`;
      const fresh = await this.read(tx, cardId);
      // ADR-0027 D4: the card was edited meanwhile; its own call decides.
      const current = fresh !== null && fresh.hash === hash;
      const closed = await this.closeRun(
        tx,
        run.id,
        'succeeded',
        current
          ? `work ${work.model} ${work.effort} · design ${design.model}`
          : 'superseded',
      );
      if (!closed) return null;
      if (current) {
        await tx.boardCard.update({
          where: { id: cardId },
          data: {
            recommendedModel: work.model,
            recommendedEffort: work.effort,
            recommendedReason: work.reason,
            recommendedDesignModel: design.model,
            recommendedDesignReason: design.reason,
            assessmentHash: hash,
            assessedAt: new Date(),
          },
        });
      }
      return { applied: current };
    });
    if (!ended) return;
    this.publishRun(run.projectId, run.id, 'succeeded');
    if (ended.applied) this.publishCard(run.projectId, cardId);
  }

  /** The card's input and its hash, as it stands in `db`; `null` without the card. */
  private async read(db: Tx | PrismaService, cardId: string) {
    const card = await db.boardCard.findUnique({
      where: { id: cardId },
      select: {
        ...CARD_SELECT,
        attachments: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { name: true, mime: true },
        },
        design: { select: { needed: true, status: true } },
        rounds: {
          orderBy: { round: 'desc' },
          take: 1,
          select: { phase: true, feedback: true },
        },
      },
    });
    if (!card) return null;
    const { attachments, design, rounds, ...rest } = card;
    const latest = rounds[0];
    const input: CardAssessInput = {
      title: rest.title,
      body: rest.body,
      kind: rest.kind as BoardCardKind,
      attachments,
      designApproved: design?.needed === true && design.status === 'approved',
      feedback: latest?.feedback ?? null,
    };
    const found: AssessedCard = {
      card: rest,
      input,
      hash: cardAssessHash(input),
      roundActive: isActiveRoundPhase(latest?.phase),
    };
    return found;
  }

  /** A running call of the card already asks this input. */
  private async asking(
    db: Tx | PrismaService,
    runId: string | null,
    hash: string,
  ): Promise<boolean> {
    if (runId === null) return false;
    const run = await db.run.findUnique({
      where: { id: runId },
      select: { status: true, args: true },
    });
    if (run?.status !== 'running') return false;
    const args = runArgsSchema.safeParse(run.args);
    return args.success && args.data.hash === hash;
  }

  /** The card's text or a round's feedback is being normalized. */
  private async normalizing(cardId: string): Promise<boolean> {
    const active = await this.prisma.textNormalization.count({
      where: {
        status: { in: ['pending', 'running'] },
        OR: [{ cardId }, { round: { cardId } }],
      },
    });
    return active > 0;
  }

  /** D8: at most `CARD_ASSESS_MAX_RUNNING_PER_PROJECT` running per project. */
  private async busy(projectId: string, db: Tx): Promise<boolean> {
    const running = await db.run.count({
      where: { projectId, kind: 'card_assess', status: 'running' },
    });
    return running >= CARD_ASSESS_MAX_RUNNING_PER_PROJECT;
  }

  /** A running call whose result never came failed. */
  private async giveUpStale(projectId: string, now: Date): Promise<void> {
    const stale = await this.prisma.run.findMany({
      where: {
        projectId,
        kind: 'card_assess',
        status: 'running',
        startedAt: { lt: new Date(now.getTime() - ASSESS_STALE_MS) },
      },
      select: { id: true },
    });
    for (const run of stale) {
      await this.fail(projectId, run.id, 'no result from the runner');
    }
  }

  /** D7: the run ends `failed` and the card keeps what it had. */
  private async fail(
    projectId: string,
    runId: string,
    error: string,
  ): Promise<void> {
    const closed = await this.prisma.$transaction((tx) =>
      this.closeRun(tx, runId, 'failed', error),
    );
    if (closed) this.publishRun(projectId, runId, 'failed');
  }

  /** Ends a running run, once; `false` when it had ended already. */
  private async closeRun(
    tx: Tx,
    runId: string,
    status: RunStatus,
    outcome: string,
  ): Promise<boolean> {
    const run = await tx.run.findUnique({
      where: { id: runId },
      select: { startedAt: true, endedAt: true },
    });
    if (!run || run.endedAt !== null) return false;
    const now = new Date();
    const { count } = await tx.run.updateMany({
      where: { id: runId, endedAt: null },
      data: {
        status,
        endedAt: now,
        durationMs: now.getTime() - run.startedAt.getTime(),
        updatedAt: now,
        outcome: outcome.slice(0, OUTCOME_MAX),
      },
    });
    return count > 0;
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

  /** The board's own live event: the card's recommendation changed. */
  private publishCard(projectId: string, cardId: string) {
    const data: BoardChangedData = { cardId };
    try {
      this.live.publish(`project:${projectId}`, BOARD_CHANGED_EVENT, data);
    } catch (error) {
      this.logger.warn(
        `board.changed ${cardId} not published: ${(error as Error).message}`,
      );
    }
  }
}
