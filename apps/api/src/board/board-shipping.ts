import {
  ACTIVE_CARD_ROUND_PHASES,
  CARD_CI_FIX_ATTEMPTS_MAX,
  CARD_CI_POLL_MS,
  type CardCiFixInput,
  type CardCiState,
  type CardCollectOutcome,
  cardAutoMergeEnabled,
  cardCiStateOf,
  cardLabel,
  failedCardChecks,
  isActiveRoundPhase,
} from '@agentdock/shared';
import type { CardChecksResult } from '@agentdock/shared/protocol';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { SYSTEM_ACTOR } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { BoardCommands, boardOutput } from './board-commands';
import { BoardFailure } from './board-error';
import type { CardWithRounds } from './board-mapper';
import { BoardRoundsService } from './board-rounds.service';
import { BOARD_SYSTEM_ACTOR, type BoardProject, BoardWork } from './board-work';

/** The poller runs outside tests; a test drives `poll` and `check` itself. */
export const shippingAutoStart = (env: NodeJS.ProcessEnv = process.env) =>
  env.APP_ENV !== 'test';

/** #359 D6: the reason `needsPerson` is audited with. */
export const CI_STILL_FAILING = 'ci_still_failing';

/**
 * #359 D6: the project's own checks, as the fix prompt names them —
 * `orchestrator.checks`, one command per line; `null` without them.
 */
export const projectChecksOf = (config: Prisma.JsonValue): string | null => {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return null;
  }
  const orchestrator = config.orchestrator;
  if (
    !orchestrator ||
    typeof orchestrator !== 'object' ||
    Array.isArray(orchestrator)
  ) {
    return null;
  }
  const checks = orchestrator.checks;
  const lines =
    typeof checks === 'string'
      ? [checks]
      : Array.isArray(checks)
        ? checks.filter((c): c is string => typeof c === 'string')
        : [];
  const text = lines
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
  return text || null;
};

/**
 * #359 D9: the card is In progress for a round — the board moved it there,
 * or a round started after the person's own move.
 */
const roundSinceMove = (card: CardWithRounds): boolean => {
  if (card.movedById === null) return true;
  const latest = card.rounds[0];
  return latest !== undefined && latest.startedAt >= card.movedAt;
};

/**
 * Cards whose PR the poller reads (#359 D5): an open PR, not merged, of a
 * card that ships itself, either In progress with its round over — CI
 * decides where it goes (D7) — or with checks still running.
 */
const WATCHED = {
  source: { notIn: ['fleet', 'terminal'] },
  prNumber: { not: null },
  prState: { in: ['open', 'draft'] },
  mergedAt: null,
  needsPerson: false,
  OR: [
    {
      column: 'in_progress',
      rounds: { none: { phase: { in: [...ACTIVE_CARD_ROUND_PHASES] } } },
    },
    { column: { in: ['in_progress', 'finished'] }, ciState: 'pending' },
  ],
} satisfies Prisma.BoardCardWhereInput;

/**
 * A card ships itself (issue #359, ADR-0035), the API's half: AgentDock
 * watches the checks of a card's PR through the runner (`card.checks`, D5),
 * turns red CI or a conflict into a `ci_fix` round — at most
 * `CARD_CI_FIX_ATTEMPTS_MAX` per PR, then `needsPerson` (D6) — moves the
 * card to Finished when its worker is done and CI is green (D7), and then
 * merges it when the project's auto-merge is on. Everything it does runs as
 * the system actor and is audited.
 */
@Injectable()
export class BoardShipping
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(BoardShipping.name);
  private readonly inFlight = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private polling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly work: BoardWork,
    private readonly rounds: BoardRoundsService,
    private readonly commands: BoardCommands,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.work.onRoundCollected((cardId, outcome) =>
      this.afterRound(cardId, outcome),
    );
  }

  onApplicationBootstrap(): void {
    if (!shippingAutoStart()) return;
    this.timer = setInterval(() => {
      void this.poll().catch((error: unknown) =>
        this.logger.error(
          'the card CI poll failed',
          error instanceof Error ? error.stack : String(error),
        ),
      );
    }, CARD_CI_POLL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /**
   * #359 D5: one pass of the poller over every watched card, each on its own
   * project's runner — a card is only ever read through the runner of its
   * project. A runner that does not serve `card.checks` is skipped.
   */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const cards = await this.prisma.boardCard.findMany({
        where: WATCHED,
        select: { id: true, project: { select: { runnerId: true } } },
        orderBy: { updatedAt: 'asc' },
      });
      for (const card of cards) {
        if (!this.commands.servesChecks(card.project.runnerId)) continue;
        await this.check(card.id);
      }
    } finally {
      this.polling = false;
    }
  }

  /**
   * #359 D7: after a round's collect. With an open PR, CI decides; without
   * one — the collect failed or found nothing — the card goes to Finished as
   * before #359, where its collect is retried or a person opens the PR.
   */
  async afterRound(
    cardId: string,
    outcome: CardCollectOutcome | null,
  ): Promise<void> {
    if (outcome?.state === 'ok' && outcome.prNumber !== null) {
      await this.check(cardId);
      return;
    }
    const card = await this.prisma.boardCard.findUnique({
      where: { id: cardId },
      include: { rounds: { orderBy: { round: 'desc' } } },
    });
    if (!card || card.column !== 'in_progress') return;
    await this.toFinished(await this.work.project(card.projectId), card);
  }

  /**
   * #359 D5–D7: reads the card's PR checks once and acts on them. Never
   * throws for the runner: a failed read is logged and the next poll tries
   * again. Runs once per card at a time.
   */
  async check(cardId: string): Promise<void> {
    if (this.inFlight.has(cardId)) return;
    this.inFlight.add(cardId);
    try {
      await this.checkNow(cardId);
    } catch (error) {
      if (!(error instanceof BoardFailure)) throw error;
      this.logger.warn(`card CI of ${cardId} not read: ${error.message}`);
    } finally {
      this.inFlight.delete(cardId);
    }
  }

  private async checkNow(cardId: string): Promise<void> {
    const card = await this.prisma.boardCard.findUnique({
      where: { id: cardId },
      include: { rounds: { orderBy: { round: 'desc' } } },
    });
    if (!card || card.prNumber === null || card.mergedAt !== null) return;
    if (card.column !== 'in_progress' && card.column !== 'finished') return;
    const project = await this.work.project(card.projectId);
    if (!this.work.ships(project, card)) return;
    // In Finished, only a merge is left to decide.
    if (
      card.column === 'finished' &&
      (card.needsPerson || !(await this.autoMergeOn(project)))
    ) {
      return;
    }

    const result = boardOutput(
      'card.checks',
      await this.commands.checks(
        project.runnerId,
        {
          cardId: card.id,
          projectId: project.id,
          root: project.rootPath,
          pr: card.prNumber,
        },
        { role: 'operator', ctx: { actor: SYSTEM_ACTOR } },
      ),
    );
    const state = cardCiStateOf(result.checks);
    // A head with no checks is "no checks" only on its second read: CI
    // registers its checks a moment after a push.
    const noChecks =
      state === 'none' &&
      card.ciState === 'none' &&
      card.ciHeadSha === result.headSha &&
      card.ciCheckedAt !== null;
    await this.store(card, result, state);

    if (result.state === 'merged') {
      await this.mergedOutside(project, card);
      return;
    }
    // A closed PR is a person's decision; there is nothing to ship.
    if (result.state === 'closed') return;
    // D6: a fix round waits for the worker's round to be over.
    if (isActiveRoundPhase(card.rounds[0]?.phase) || card.needsPerson) return;

    if (card.column === 'in_progress') {
      // D9: a card a person dragged back to In progress, with no round
      // since, waits for them.
      if (!roundSinceMove(card)) return;
      const conflict = result.mergeable === 'CONFLICTING';
      if (conflict || state === 'red') {
        await this.fix(project, card, result, conflict);
        return;
      }
      if (state !== 'green' && !noChecks) return;
      if (!(await this.toFinished(project, card))) return;
    } else if (state !== 'green' && !noChecks) {
      return;
    }
    await this.autoMerge(project, card.number, result.headSha);
  }

  /** D5: the checks on the card, and the PR's state on its row. */
  private async store(
    card: CardWithRounds,
    result: CardChecksResult,
    state: CardCiState,
  ): Promise<void> {
    const prState = result.state;
    await this.prisma.boardCard.update({
      where: { id: card.id },
      data: {
        ciState: state,
        ciChecks:
          state === 'red' ? failedCardChecks(result.checks) : Prisma.DbNull,
        ciHeadSha: result.headSha,
        ciCheckedAt: new Date(),
        ...(prState !== 'merged' ? { prState } : {}),
      },
    });
    if (prState !== 'merged' && card.prNumber !== null) {
      await this.prisma.boardCardPullRequest.updateMany({
        where: { cardId: card.id, number: card.prNumber },
        data: { state: prState },
      });
    }
    this.work.publish(card.projectId, card.id);
  }

  /**
   * D6: a `ci_fix` round, or — the budget spent — `needsPerson`, and the
   * card goes to Finished, where a person's feedback or Accept takes it on.
   */
  private async fix(
    project: BoardProject,
    card: CardWithRounds,
    result: CardChecksResult,
    conflict: boolean,
  ): Promise<void> {
    if (card.ciFixAttempts >= CARD_CI_FIX_ATTEMPTS_MAX) {
      await this.prisma.boardCard.update({
        where: { id: card.id },
        data: { needsPerson: true },
      });
      await this.audit.record({
        actor: SYSTEM_ACTOR,
        action: 'card.auto_run_failed',
        target: { type: 'board_card', id: card.id },
        projectId: project.id,
        after: {
          number: card.number,
          reason: CI_STILL_FAILING,
          pr: card.prNumber,
          headSha: result.headSha,
          conflict,
          attempts: card.ciFixAttempts,
        },
        result: 'ok',
      });
      this.work.publish(project.id, card.id);
      await this.toFinished(project, card);
      return;
    }
    const input: CardCiFixInput = conflict
      ? { reason: 'conflict', base: project.base }
      : {
          reason: 'red',
          headSha: result.headSha,
          failed: failedCardChecks(result.checks),
          checks: projectChecksOf(project.codeSentinelConfig),
        };
    try {
      await this.rounds.ciFix(project.id, card.number, input);
    } catch (error) {
      // No room, a budget stop, the runner away: the next poll tries again.
      if (!(error instanceof BoardFailure)) throw error;
      this.logger.warn(
        `ci_fix round of ${cardLabel(card.number)} not started: ${error.message}`,
      );
    }
  }

  /** D7: the card enters Finished; its round's collect already ran. */
  private async toFinished(
    project: BoardProject,
    card: Pick<CardWithRounds, 'projectId' | 'number'>,
  ): Promise<boolean> {
    const fresh = await this.work.card(project.id, card.number);
    if (fresh.column !== 'in_progress') return false;
    if (isActiveRoundPhase(fresh.rounds[0]?.phase)) return false;
    try {
      await this.work.move(
        project,
        fresh,
        { to: 'finished', index: 0, source: 'automatic', collect: false },
        BOARD_SYSTEM_ACTOR,
      );
      return true;
    } catch (error) {
      if (!(error instanceof BoardFailure)) throw error;
      this.logger.warn(
        `${cardLabel(card.number)} not moved to Finished: ${error.message}`,
      );
      return false;
    }
  }

  /** D8: the PR was merged on GitHub — the card is Merged, in Finished. */
  private async mergedOutside(
    project: BoardProject,
    card: CardWithRounds,
  ): Promise<void> {
    if (card.prNumber === null) return;
    await this.work.markMerged(card.id, card.prNumber);
    this.work.publish(project.id, card.id);
    if (card.column === 'in_progress') await this.toFinished(project, card);
  }

  /** D7: the project's switch, `null` following the base. */
  private async autoMergeOn(project: BoardProject): Promise<boolean> {
    const settings = await this.prisma.boardSettings.findUnique({
      where: { projectId: project.id },
      select: { autoMergeCards: true },
    });
    return cardAutoMergeEnabled(
      settings?.autoMergeCards ?? null,
      project.base,
      project.defaultBranch,
    );
  }

  /**
   * D7: with auto-merge on, the green head is merged through `card.merge`
   * — the project's method, the branch deleted, the card's issue closed
   * (D4). A refusal is audited and the card waits for Accept.
   */
  private async autoMerge(
    project: BoardProject,
    number: number,
    headSha: string,
  ): Promise<void> {
    if (!(await this.autoMergeOn(project))) return;
    // `deleteBranch` needs a runner of `card.prClose`'s release (#329 D9).
    if (!this.commands.advertisesPrClose(project.runnerId)) return;
    const card = await this.work.card(project.id, number);
    if (
      card.column !== 'finished' ||
      card.mergedAt !== null ||
      card.needsPerson
    ) {
      return;
    }
    try {
      await this.work.mergePr(project, card, headSha, true, BOARD_SYSTEM_ACTOR);
    } catch (error) {
      if (!(error instanceof BoardFailure)) throw error;
      this.logger.warn(
        `auto-merge of ${cardLabel(card.number)} refused: ${error.message}`,
      );
    }
    this.work.publish(project.id, card.id);
  }
}
