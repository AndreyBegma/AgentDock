import {
  ACTIVE_CARD_ROUND_PHASES,
  CARD_CI_FIX_ATTEMPTS_MAX,
  CARD_CI_MISSING_MS,
  CARD_CI_POLL_MS,
  CARD_ROUND_AT_ONCE_MS,
  type CardCiFixInput,
  type CardCiState,
  type CardCollectOutcome,
  type CardNeedsPersonReason,
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
export const CI_STILL_FAILING =
  'ci_still_failing' satisfies CardNeedsPersonReason;

/**
 * #484: the reason `needsPerson` is audited with when a head of a project
 * with CI got no checks, even after `card.ciRetrigger`.
 */
export const CI_NOT_REPORTED =
  'ci_not_reported' satisfies CardNeedsPersonReason;

/**
 * #542: why auto-merge refuses the head the card's latest round left, or
 * `null` when it may ship it. A round that failed, that left the PR's head
 * as it found it — it pushed no commit — or that ended within
 * `CARD_ROUND_AT_ONCE_MS` of its start did not do the card's work, so the
 * green CI is the old head's.
 */
export const roundUnshippable = (
  round: Pick<
    CardWithRounds['rounds'][number],
    'phase' | 'startHeadSha' | 'startedAt' | 'finishedAt'
  > | null,
  headSha: string,
): CardNeedsPersonReason | null => {
  if (!round) return null;
  if (round.phase === 'failed') return 'round_failed';
  if (round.startHeadSha !== null && round.startHeadSha === headSha) {
    return 'round_pushed_nothing';
  }
  if (
    round.finishedAt !== null &&
    round.finishedAt.getTime() - round.startedAt.getTime() <
      CARD_ROUND_AT_ONCE_MS
  ) {
    return 'round_ended_at_once';
  }
  return null;
};

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
    // #636: stacked on a dependency that merged — still to be retargeted.
    // #709: any stacked PR — its dependency, or the PR itself, may merge on
    // GitHub unseen.
    { column: { in: ['in_progress', 'finished'] }, prBase: { not: null } },
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
  /** #722: merged cards whose stored base the backfill has read on GitHub. */
  private readonly basesRead = new Set<string>();
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
      await this.backfillMergedBases();
    } finally {
      this.polling = false;
    }
  }

  /**
   * #722: the backfill. Every card recorded as merged with a stored base is
   * read on GitHub once after the API starts — so once per deploy — when
   * its project's runner serves `card.checks`: one whose PR went into the
   * project base after a retarget by hand is no longer stacked. A read the
   * runner could not answer is tried again by the next poll.
   */
  async backfillMergedBases(): Promise<void> {
    const cards = await this.prisma.boardCard.findMany({
      where: {
        mergedAt: { not: null },
        prBase: { not: null },
        prNumber: { not: null },
      },
      select: {
        id: true,
        prNumber: true,
        projectId: true,
        project: { select: { runnerId: true } },
      },
      orderBy: { number: 'asc' },
    });
    const projects = new Map<string, BoardProject>();
    for (const card of cards) {
      if (this.basesRead.has(card.id)) continue;
      if (!this.commands.servesChecks(card.project.runnerId)) continue;
      let project = projects.get(card.projectId);
      if (!project) {
        project = await this.work.project(card.projectId);
        projects.set(card.projectId, project);
      }
      if ((await this.work.refreshMergedBase(project, card)) !== null) {
        this.basesRead.add(card.id);
      }
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
    let card = await this.prisma.boardCard.findUnique({
      where: { id: cardId },
      include: { rounds: { orderBy: { round: 'desc' } } },
    });
    if (!card || card.prNumber === null || card.mergedAt !== null) return;
    if (card.column !== 'in_progress' && card.column !== 'finished') return;
    const project = await this.work.project(card.projectId);
    if (!this.work.ships(project, card)) return;
    // #636: a PR stacked on a dependency that has merged since goes onto the
    // base — the retry of what the merge could not do. #709: the dependency
    // is read on GitHub, and the retarget may find the PR itself merged —
    // landed, or carried forward in a new PR the next poll reads.
    if (card.prBase !== null) {
      const pr = card.prNumber;
      await this.work.retargetIfDue(project, card);
      card = await this.prisma.boardCard.findUnique({
        where: { id: cardId },
        include: { rounds: { orderBy: { round: 'desc' } } },
      });
      if (!card || card.prNumber !== pr) return;
      if (card.mergedAt !== null) {
        if (card.column === 'in_progress') await this.toFinished(project, card);
        return;
      }
    }
    const prNumber = card.prNumber;
    // In Finished, only a merge is left to decide. #709: a stacked PR, or a
    // forward PR, is still read — for a merge on GitHub, or a conflict.
    const mergeOnly =
      card.column === 'finished' &&
      (card.needsPerson || !(await this.autoMergeOn(project)));
    const forward = await this.work.forwarded(card.id, prNumber);
    if (mergeOnly && card.prBase === null && !forward) return;

    const result = boardOutput(
      'card.checks',
      await this.commands.checks(
        project.runnerId,
        {
          cardId: card.id,
          projectId: project.id,
          root: project.rootPath,
          pr: prNumber,
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
    const noneSince = await this.store(card, result, state);

    if (result.state === 'merged') {
      await this.mergedOutside(project, card, result);
      return;
    }
    // #722: a stacked PR a person moved onto the base on GitHub.
    if (
      card.prBase !== null &&
      (await this.work.adoptLiveBase(
        project,
        card.id,
        prNumber,
        result.base ?? null,
      ))
    ) {
      card = { ...card, prBase: null, prBaseCardId: null };
    }
    // A closed PR is a person's decision; there is nothing to ship.
    if (result.state === 'closed') return;
    // #709: a forward PR that conflicts in Finished waits for a person.
    if (
      forward &&
      card.column === 'finished' &&
      result.mergeable === 'CONFLICTING'
    ) {
      await this.work.forwardConflict(project, card);
      return;
    }
    if (mergeOnly) return;
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
      if (state !== 'green') {
        if (!noChecks) return;
        if (!(await this.shipsWithoutChecks(project, card, result, noneSince)))
          return;
      }
      if (!(await this.toFinished(project, card))) return;
    } else if (state !== 'green') {
      if (!noChecks) return;
      if (!(await this.shipsWithoutChecks(project, card, result, noneSince)))
        return;
    }
    await this.autoMerge(project, card.number, result.headSha);
  }

  /**
   * #484 (ADR-0043): whether a head with no checks ships as one. In a project
   * whose CI never reported on a card, it does, as before. Otherwise the
   * forge's event was probably lost — a CI that answered its webhook with an
   * error never gets it again — so after `CARD_CI_MISSING_MS` the PR's event
   * is sent again once per head (`card.ciRetrigger`), and a head still
   * without checks `CARD_CI_MISSING_MS` after that marks the card
   * `needsPerson`. It never ships unchecked.
   */
  private async shipsWithoutChecks(
    project: BoardProject,
    card: CardWithRounds,
    result: CardChecksResult,
    noneSince: Date,
  ): Promise<boolean> {
    if (!(await this.hasCi(project.id))) return true;
    if (Date.now() - noneSince.getTime() < CARD_CI_MISSING_MS) return false;
    if (
      card.ciRetriggeredSha !== result.headSha &&
      this.commands.servesCiRetrigger(project.runnerId)
    ) {
      await this.retrigger(project, card, result.headSha);
      return false;
    }
    await this.ciNotReported(project, card, result.headSha, null);
    return false;
  }

  /** #484: a project's CI has reported on one of its card PRs. */
  private async hasCi(projectId: string): Promise<boolean> {
    const reported = await this.prisma.boardCard.findFirst({
      where: { projectId, ciState: { in: ['pending', 'green', 'red'] } },
      select: { id: true },
    });
    return reported !== null;
  }

  /**
   * #484: `card.ciRetrigger`, audited. The head counts as retriggered — and
   * its wait starts again — whatever `gh` answered, except for a PR that
   * moved on or is no longer open, which the next read sees. A PR left
   * closed is a person's to reopen.
   */
  private async retrigger(
    project: BoardProject,
    card: CardWithRounds,
    headSha: string,
  ): Promise<void> {
    if (card.prNumber === null) return;
    const result = boardOutput(
      'card.ciRetrigger',
      await this.commands.ciRetrigger(
        project.runnerId,
        {
          cardId: card.id,
          projectId: project.id,
          root: project.rootPath,
          pr: card.prNumber,
          headSha,
        },
        { role: 'operator', ctx: { actor: SYSTEM_ACTOR } },
      ),
    );
    if (
      !result.retriggered &&
      (result.error === 'head_moved' || result.error === 'not_open')
    ) {
      return;
    }
    await this.prisma.boardCard.update({
      where: { id: card.id },
      data: { ciRetriggeredSha: headSha, ciNoneSince: new Date() },
    });
    await this.audit.record({
      actor: SYSTEM_ACTOR,
      action: 'card.ci_retriggered',
      target: { type: 'board_card', id: card.id },
      projectId: project.id,
      after: {
        number: card.number,
        pr: card.prNumber,
        headSha,
        ...(result.retriggered
          ? {}
          : { error: result.error, message: result.message }),
      },
      result: result.retriggered ? 'ok' : 'error',
    });
    this.work.publish(project.id, card.id);
    if (!result.retriggered && result.error === 'reopen_failed') {
      await this.ciNotReported(project, card, headSha, result.message);
    }
  }

  /** #484: CI never reported on the head — `needsPerson`, then Finished. */
  private async ciNotReported(
    project: BoardProject,
    card: CardWithRounds,
    headSha: string,
    message: string | null,
  ): Promise<void> {
    await this.prisma.boardCard.update({
      where: { id: card.id },
      data: { needsPerson: true, needsPersonReason: CI_NOT_REPORTED },
    });
    await this.audit.record({
      actor: SYSTEM_ACTOR,
      action: 'card.auto_run_failed',
      target: { type: 'board_card', id: card.id },
      projectId: project.id,
      after: {
        number: card.number,
        reason: CI_NOT_REPORTED,
        pr: card.prNumber,
        headSha,
        retriggered: card.ciRetriggeredSha === headSha,
        ...(message ? { message } : {}),
      },
      result: 'ok',
    });
    this.work.publish(project.id, card.id);
    await this.toFinished(project, card);
  }

  /**
   * D5: the checks on the card, and the PR's state on its row. Answers since
   * when the head has had no checks (#484) — now, when it has some.
   */
  private async store(
    card: CardWithRounds,
    result: CardChecksResult,
    state: CardCiState,
  ): Promise<Date> {
    const prState = result.state;
    const now = new Date();
    const noneSince =
      state === 'none' &&
      card.ciState === 'none' &&
      card.ciHeadSha === result.headSha &&
      card.ciNoneSince !== null
        ? card.ciNoneSince
        : now;
    await this.prisma.boardCard.update({
      where: { id: card.id },
      data: {
        ciState: state,
        ciChecks:
          state === 'red' ? failedCardChecks(result.checks) : Prisma.DbNull,
        ciHeadSha: result.headSha,
        ciCheckedAt: now,
        ciNoneSince: state === 'none' ? noneSince : null,
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
    return noneSince;
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
        data: { needsPerson: true, needsPersonReason: CI_STILL_FAILING },
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
      ? { reason: 'conflict', base: card.prBase ?? project.base }
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

  /**
   * D8: the PR was merged on GitHub — the card is Merged, in Finished. #709:
   * with the branch it went into and when, so a stacked PR merged into a
   * dependency branch that had already merged is carried forward.
   */
  private async mergedOutside(
    project: BoardProject,
    card: CardWithRounds,
    result: CardChecksResult,
  ): Promise<void> {
    if (card.prNumber === null) return;
    await this.work.markMerged(card.id, card.prNumber, {
      state: 'merged',
      base: result.base ?? null,
      mergedAt: result.mergedAt ? new Date(result.mergedAt) : null,
    });
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
   * (D4). A refusal is audited and the card waits for Accept. #542: a head
   * the latest round did not work on (`roundUnshippable`) is never merged —
   * the card gets `needsPerson` with the reason and stays in Finished.
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
    // #636: a PR stacked on a dependency's branch is merged by no one but a
    // person; it goes into the base once the dependency merges.
    if (
      card.column !== 'finished' ||
      card.mergedAt !== null ||
      card.needsPerson ||
      card.prBase !== null
    ) {
      return;
    }
    const unshippable = roundUnshippable(card.rounds[0] ?? null, headSha);
    if (unshippable !== null) {
      await this.refuseMerge(project, card, headSha, unshippable);
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

  /** #542: the head is not the round's work — `needsPerson`, audited. */
  private async refuseMerge(
    project: BoardProject,
    card: CardWithRounds,
    headSha: string,
    reason: CardNeedsPersonReason,
  ): Promise<void> {
    const round = card.rounds[0];
    await this.prisma.boardCard.update({
      where: { id: card.id },
      data: { needsPerson: true, needsPersonReason: reason },
    });
    await this.audit.record({
      actor: SYSTEM_ACTOR,
      action: 'card.auto_run_failed',
      target: { type: 'board_card', id: card.id },
      projectId: project.id,
      after: {
        number: card.number,
        reason,
        pr: card.prNumber,
        headSha,
        ...(round ? { round: round.round, phase: round.phase } : {}),
      },
      result: 'ok',
    });
    this.logger.warn(
      `auto-merge of ${cardLabel(card.number)} refused: ${reason}`,
    );
    this.work.publish(project.id, card.id);
  }
}
