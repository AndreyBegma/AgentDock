import { randomUUID } from 'node:crypto';
import {
  BOARD_ERROR,
  type BoardCardDetail,
  CARD_SUMMARY_MAX,
  CARD_WORKER_PROMPT_VERSION,
  type CardAttachmentBrief,
  type CardChange,
  type CardCiFixInput,
  type CardEscalationReason,
  type CardReviewFixFinding,
  type CardRoundPhase,
  type CardRoundTrigger,
  type CardWorkerDemo,
  cardAttachmentSnapshotSchema,
  cardBranch,
  cardChange,
  cardCiFixPrompt,
  cardDesignPath,
  cardDraftPullRequest,
  cardFollowUpBranch,
  cardIssueBody,
  cardLabel,
  cardNextRoundPrompt,
  cardRecommendationOf,
  cardReviewFixPrompt,
  cardSpecPath,
  cardSpecPrBody,
  cardWorkerPrompt,
  demoScenarioPath,
  isActiveRoundPhase,
  stackDesignPath,
  stackLabel,
} from '@nautelle/shared';
import {
  CARD_RUN_PROMPT_MAX_BYTES,
  type Capabilities,
  type CardRunArgs,
  type CardRunFile,
  capabilitiesSchema,
  cardDemoAvailable,
  cardDocsBranch,
  cardEffortAvailable,
  cardEscalateAvailable,
  cardFreshStartAvailable,
  cardRunArgsSchema,
  cardStartBranchAvailable,
  ISSUE_TITLE_MAX,
  ORCHESTRATOR_DEFAULTS,
  type OrchestratorPermissionMode,
  orchestratorPermissionModeSchema,
} from '@nautelle/shared/protocol';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { CardAssessor } from '../assess/card-assessor';
import {
  AttachmentsService,
  toAttachmentBrief,
  toAttachmentRef,
} from '../attachments/attachments.service';
import { AuditService } from '../audit/audit.service';
import { SYSTEM_ACTOR } from '../audit/audit.types';
import { BudgetGate } from '../budgets/budget-gate';
import { PrismaService } from '../database/prisma.service';
import {
  type FrameFile,
  frameNameSelect,
  frameNamesOf,
  revisionFrames,
} from '../design/design-store';
import { resolveSpecTarget, type SpecTarget } from '../planner/spec-target';
import { withCardPrefix } from '../prefix/card-prefix';
import { PrefixLaunchService } from '../prefix/prefix-launch';
import { RuntimeProfileResolver } from '../readiness';
import { TextNormalizer } from '../text/text-normalizer';
import { TokenEconomyService } from '../token-economy/token-economy.service';
import {
  type TokenSaverLaunch,
  TokenSaverService,
} from '../token-saver/token-saver.service';
import { BoardService } from './board.service';
import { BoardCommands, boardOutput } from './board-commands';
import {
  BoardDependencies,
  type StackedBase,
} from './board-dependencies.service';
import { autoRunFailureOf, BoardFailure, boardError } from './board-error';
import type { CardWithRounds } from './board-mapper';
import { toSettingsView } from './board-mapper';
import { BoardPrincipals } from './board-principal';
import { BoardStacks } from './board-stacks';
import {
  ACTIVE_PHASES,
  BOARD_SYSTEM_ACTOR,
  type BoardActor,
  type BoardProject,
  BoardWork,
} from './board-work';
import type { CardFeedbackDto, RunBoardCardDto } from './dto';
import {
  defaultCardLaunch,
  isOpusModel,
  MODEL_BY_TYPE,
  rememberedChoice,
  startBranchChoice,
  startBranchOutcome,
} from './launch-choice';

type Tx = Prisma.TransactionClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** #884: why a `review_fix` round starts — the blocking findings on the head. */
export interface CardReviewFixInput {
  reason: 'review';
  headSha: string;
  findings: readonly CardReviewFixFinding[];
}

/** Why one of Nautelle's own fix rounds starts. */
type RoundFix = CardCiFixInput | CardReviewFixInput;

/** #884: the rounds Nautelle starts itself, as a person, on the card's PR. */
const isFixRound = (trigger: CardRoundTrigger): boolean =>
  trigger === 'ci_fix' || trigger === 'review_fix';

/** #750: `card.escalate` refused — answered `not_escalatable`. */
export class CardNotEscalatable extends Error {
  constructor() {
    super('this round cannot escalate');
  }
}

/** #447 DA-15: the mode a round started in (`runs.args.permissionMode`). */
const permissionModeOf = (
  args: Prisma.JsonValue,
): OrchestratorPermissionMode | undefined => {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return undefined;
  }
  const stored = orchestratorPermissionModeSchema.safeParse(
    args.permissionMode,
  );
  return stored.success ? stored.data : undefined;
};

/** #750 D9: what an escalation round runs at. */
const CARD_ESCALATION_LAUNCH = { model: 'opus', effort: 'high' } as const;

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

/**
 * #750 D9: the escalation round's prompt — the next-round prompt with the
 * previous worker's finding after it. When the change since the last round
 * leaves no room for it, the plain `continue` prompt carries it instead.
 */
export const escalationRoundPrompt = (
  card: Pick<
    CardWithRounds,
    'escalationReason' | 'escalationNote' | 'sessionModel'
  >,
  withChange: string,
  plain: string,
): string => {
  if (card.escalationReason === null || card.escalationNote === null) {
    return withChange;
  }
  const finding = [
    '## The previous worker asked for Opus',
    '',
    `The previous round${card.sessionModel ? ` (on \`${card.sessionModel}\`)` : ''} stopped and asked for this round, reason \`${card.escalationReason}\`. Its finding:`,
    '',
    card.escalationNote,
  ].join('\n');
  const prompt = `${withChange}\n\n${finding}`;
  return utf8Bytes(prompt) <= CARD_RUN_PROMPT_MAX_BYTES
    ? prompt
    : `${plain}\n\n${finding}`;
};

/** D2: the spec the runner commits as the branch's first commit. */
const specContent = (card: CardWithRounds, issueNumber: number | null) =>
  [
    `# ${cardLabel(card.number)}: ${card.title}`,
    '',
    ...(issueNumber !== null ? [`Issue: #${issueNumber}`, ''] : []),
    card.body.trim() || '(no description)',
    '',
  ].join('\n');

/** #379: a card's spec in an external docs repository, and its pull request. */
interface CardSpecPr {
  path: string;
  repo: string;
  number: number;
  url: string;
  branch: string;
}

/** #379: the spec pull request an earlier Run opened, if any. */
const cardSpecPrOf = (card: CardWithRounds): CardSpecPr | null =>
  card.specRepo !== null &&
  card.specPath !== null &&
  card.specPrNumber !== null &&
  card.specPrUrl !== null
    ? {
        path: card.specPath,
        repo: card.specRepo,
        number: card.specPrNumber,
        url: card.specPrUrl,
        branch: cardDocsBranch(card.shortId),
      }
    : null;

/**
 * Phases of a round that never started Claude: still queued, or `failed` —
 * the runner could not start it. Any other round used the session.
 */
const UNSTARTED_PHASES: ReadonlySet<CardRoundPhase> = new Set([
  'queued',
  'failed',
]);

/**
 * #309 D10: a round's `cardAttachments`; a row from before the snapshot
 * existed — or one that does not parse — knew of none.
 */
const snapshotOf = (json: Prisma.JsonValue): CardAttachmentBrief[] => {
  const parsed = cardAttachmentSnapshotSchema.safeParse(json);
  return parsed.success ? parsed.data : [];
};

/**
 * #273 D1: how the card's text differs from what the worker was last given —
 * the snapshot of the newest round that started Claude. `null` without one.
 * #309 D10: and which attachments were added or removed since.
 */
const changeSinceLastRound = (
  card: CardWithRounds,
  attachments: readonly CardAttachmentBrief[],
): CardChange | null => {
  const last = card.rounds.find((r) => !UNSTARTED_PHASES.has(r.phase));
  if (!last) return null;
  return cardChange(
    { title: last.cardTitle, body: last.cardBody, kind: last.cardKind },
    { title: card.title, body: card.body, kind: card.kind },
    { before: snapshotOf(last.cardAttachments), now: attachments },
  );
};

/**
 * What the round-1 prompt takes from the launch's Token saver. #747: the
 * scout, bypass and handoff lines exist only with it on — the card prompt
 * never carried them before. D10: the `terse-register` arm only when the
 * flags are launched, so the prompt matches the run's `techniques` snapshot;
 * absent is on (D3).
 */
export const cardPromptSaver = (
  saver: Pick<TokenSaverLaunch, 'on' | 'techniques'>,
): { tokenSaver: boolean; terseRegister?: boolean } => {
  const terseRegister = saver.techniques?.['terse-register'];
  return {
    tokenSaver: saver.on,
    ...(terseRegister !== undefined ? { terseRegister } : {}),
  };
};

/**
 * #750 D8: the round-1 prompt tells the worker when to call `escalate_card`
 * only when the launch offers the tool (`escalate` on `card.run`).
 */
export const cardPromptEscalate = (escalate: boolean): { escalate?: true } =>
  escalate ? { escalate: true } : {};

/**
 * C-369 (ADR-0090 §2): a round gets DemoFlow's MCP server and the scenario
 * section when the project records demo videos and the runner can record
 * them (`cardDemo`) — `card.run` is strict, so an older runner never sees
 * `demo`. `env` is the project's secret names, never a value.
 */
export const cardRoundDemo = (
  card: { number: number; title: string },
  demos: { enabled: boolean; env: readonly string[] },
  capabilities: Capabilities | null,
): CardWorkerDemo | null =>
  demos.enabled && capabilities !== null && cardDemoAvailable(capabilities)
    ? { scenarioPath: demoScenarioPath(card), env: demos.env }
    : null;

/**
 * Starting a round (issue #242 D4, D5, D9, D12, D13): Run — round 1 or a
 * retry — and feedback. Everything that can be refused is refused before a
 * row exists or a command is sent; the round is then a `runs` row of kind
 * `card` plus its `board_card_rounds` row, and the card moves to In progress.
 */
@Injectable()
export class BoardRoundsService {
  private readonly logger = new Logger(BoardRoundsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly work: BoardWork,
    private readonly board: BoardService,
    private readonly commands: BoardCommands,
    private readonly audit: AuditService,
    private readonly profiles: RuntimeProfileResolver,
    private readonly text: TextNormalizer,
    private readonly attachments: AttachmentsService,
    private readonly dependencies: BoardDependencies,
    private readonly stacks: BoardStacks,
    private readonly tokenSaver: TokenSaverService,
    private readonly economy: TokenEconomyService,
    private readonly assessor: CardAssessor,
    private readonly prefixLaunch: PrefixLaunchService,
    private readonly principals: BoardPrincipals,
    @Optional() private readonly budgets?: BudgetGate,
  ) {}

  /** C-369: whether the project records demo videos, and its secret names. */
  private async demoSettings(
    projectId: string,
  ): Promise<{ enabled: boolean; env: string[] }> {
    const settings = await this.prisma.boardSettings.findUnique({
      where: { projectId },
      select: { demoVideosEnabled: true },
    });
    if (!settings?.demoVideosEnabled) return { enabled: false, env: [] };
    const secrets = await this.prisma.projectDemoSecret.findMany({
      where: { projectId },
      orderBy: { name: 'asc' },
      select: { name: true },
    });
    return { enabled: true, env: secrets.map((s) => s.name) };
  }

  /**
   * `POST …/run`: round 1, or a retry after failed / ended / cancelled.
   * #443: Auto-run when ready calls it too, with `autoRunAfter` that
   * dependency's number — C-181: as the person who armed the switch.
   */
  async run(
    projectId: string,
    number: number,
    dto: RunBoardCardDto,
    actor: BoardActor,
    autoRunAfter: number | null = null,
  ): Promise<BoardCardDetail> {
    const card = await this.work.card(projectId, number);
    if (card.column === 'completed') {
      throw boardError(
        409,
        BOARD_ERROR.wrongColumn,
        'A completed card does not run; move it back first',
      );
    }
    if (card.column === 'inbox') {
      throw boardError(
        409,
        BOARD_ERROR.wrongColumn,
        'A suggestion runs once it is accepted',
      );
    }
    // #845 D10 (ADR-0083 §8): a live taking session is the card's worker.
    const takenBy = card.source !== 'terminal' ? card.trackedSessionId : null;
    if (takenBy !== null) {
      const live = await this.prisma.agentSession.count({
        where: { id: takenBy, endedAt: null },
      });
      if (live > 0) {
        throw boardError(
          409,
          BOARD_ERROR.cardRunning,
          `${cardLabel(card.number)} is taken by a live session`,
        );
      }
    }
    // #480 (ADR-0044): no card of a stack runs before its design is approved.
    await this.stacks.assertStackApproved(card.id);
    // #638 (ADR-0065): an open dependency refuses the Run; nothing overrides
    // it. #636: one unmerged dependency with an open PR stacks the card on
    // its branch.
    const stacked = await this.dependencies.assertRunnable(card.id);
    await this.start(
      card,
      'run',
      dto,
      null,
      actor,
      [],
      null,
      autoRunAfter,
      stacked,
      // #854: the gone session's branch, for the Run to continue.
      takenBy !== null ? card.takenBranch : null,
    );
    if (takenBy !== null) {
      // The Run is the card's worker now; `start` moved it onto `takenBranch`
      // when the runner took it (#854 D2), else `takenBranch` stays recorded.
      await this.prisma.boardCard.updateMany({
        where: { id: card.id, trackedSessionId: takenBy },
        data: { trackedSessionId: null },
      });
      this.work.publish(projectId, card.id);
    }
    return this.board.detail(projectId, number);
  }

  /** `POST …/feedback` (D9): a Finished card goes back with the person's text. */
  async feedback(
    projectId: string,
    number: number,
    dto: CardFeedbackDto,
    actor: BoardActor,
  ): Promise<BoardCardDetail> {
    const card = await this.work.card(projectId, number);
    if (isActiveRoundPhase(card.rounds[0]?.phase)) {
      throw this.running();
    }
    if (card.column !== 'finished' || card.sessionId === null) {
      throw boardError(
        409,
        BOARD_ERROR.wrongColumn,
        'Feedback goes to a card in Finished that has run',
      );
    }
    await this.start(
      card,
      'feedback',
      {},
      dto.text.trim(),
      actor,
      dto.attachmentIds ?? [],
    );
    return this.board.detail(projectId, number);
  }

  /**
   * #359 D6: Nautelle's own round for a red check or a merge conflict on
   * the card's PR — the card's session resumed, the `ci_fix` prompt. Counts
   * one of the PR's `ci_fix` attempts. Refused like any round (running, no
   * room, budget); the poller tries again. C-181 (D-09, D-10): it runs as the
   * person who started the card's latest round, in that round's mode — their
   * role now (bypass needs admin), their budget, charged to them.
   */
  async ciFix(
    projectId: string,
    number: number,
    input: CardCiFixInput,
  ): Promise<void> {
    const card = await this.work.card(projectId, number);
    if (card.sessionId === null) {
      throw boardError(
        409,
        BOARD_ERROR.wrongColumn,
        'A CI fix resumes the card worker, which has not run',
      );
    }
    const { actor, permissionMode } = await this.fixLaunchOf(card);
    await this.start(
      card,
      'ci_fix',
      permissionMode ? { permissionMode } : {},
      null,
      actor,
      [],
      input,
    );
  }

  /**
   * #884 (ADR-0084 §3): Nautelle's round for the blocking findings of the
   * review steps on the card's PR head — the card's session resumed, the
   * `review_fix` prompt. Counts one of the PR's review fix rounds, apart from
   * its `ci_fix` attempts. Runs as `ciFix` does: as the person who started
   * the card's latest round, in that round's mode.
   */
  async reviewFix(
    projectId: string,
    number: number,
    input: Omit<CardReviewFixInput, 'reason'>,
  ): Promise<void> {
    const card = await this.work.card(projectId, number);
    if (card.sessionId === null) {
      throw boardError(
        409,
        BOARD_ERROR.wrongColumn,
        'A review fix resumes the card worker, which has not run',
      );
    }
    const { actor, permissionMode } = await this.fixLaunchOf(card);
    await this.start(
      card,
      'review_fix',
      permissionMode ? { permissionMode } : {},
      null,
      actor,
      [],
      { reason: 'review', ...input },
    );
  }

  /**
   * C-181 (D-09, D-10): who a fix round runs as — the person who started the
   * card's latest round — and that round's mode.
   */
  async fixLaunchOf(card: CardWithRounds): Promise<{
    actor: BoardActor;
    permissionMode: OrchestratorPermissionMode | undefined;
  }> {
    const started = card.rounds.find((r) => r.authorId !== null);
    const actor = await this.principals.actor(
      card.projectId,
      started?.authorId ?? null,
    );
    const run = started
      ? await this.prisma.run.findUnique({
          where: { id: started.runId },
          select: { args: true },
        })
      : null;
    return {
      actor,
      permissionMode: run ? permissionModeOf(run.args) : undefined,
    };
  }

  /**
   * #750 D8–D10: the worker's `escalate_card`. The card is the one whose
   * Claude session asks, in the asking runner's project; any other session
   * is `null` (`not_a_card_session`). Refused `not_escalatable` unless the
   * card's latest round is active, ran on a non-Opus model, the card is in
   * the B arm of `model-by-type`, and it never escalated. It ends the round
   * like `finish_card` and stores the escalation; unless the model is a
   * person's override (D10), the `escalation` round starts once the answer
   * is out, so the runner stops the asking session first.
   */
  async escalateByWorker(
    project: { id: string; runnerId: string },
    sessionId: string,
    reason: CardEscalationReason,
    note: string,
  ): Promise<{ number: number; relaunched: boolean } | null> {
    if (!UUID.test(sessionId)) return null;
    const found = await this.prisma.boardCard.findFirst({
      where: {
        projectId: project.id,
        sessionId,
        project: { runnerId: project.runnerId },
      },
      select: { id: true, number: true },
    });
    if (!found) return null;
    const card = await this.work.card(project.id, found.number);
    const round = card.rounds[0];
    const run =
      round && isActiveRoundPhase(round.phase)
        ? await this.prisma.run.findUnique({
            where: { id: round.runId },
            select: { model: true, args: true },
          })
        : null;
    const flags = run
      ? await this.economy.cardFlags(project.id, card.id, false)
      : {};
    if (
      !round ||
      !run ||
      run.model === null ||
      isOpusModel(run.model) ||
      flags[MODEL_BY_TYPE] !== true ||
      card.escalatedAt !== null
    ) {
      throw new CardNotEscalatable();
    }
    // D9 (once): the claim, so a racing second call is refused.
    const now = new Date();
    const claimed = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.boardCard.updateMany({
        where: { id: card.id, escalatedAt: null },
        data: {
          escalatedAt: now,
          escalationReason: reason,
          escalationNote: note,
          workClass: 'deciding',
        },
      });
      if (count === 0) return false;
      await tx.boardCardRound.update({
        where: { id: round.id },
        data: { escalation: reason },
      });
      return true;
    });
    if (!claimed) throw new CardNotEscalatable();
    const target = await this.work.project(project.id);
    const escalated = await this.work.card(project.id, card.number);
    if (isActiveRoundPhase(escalated.rounds[0]?.phase)) {
      await this.work.move(
        target,
        escalated,
        {
          to: 'finished',
          index: 0,
          source: 'automatic',
          finishedBy: 'worker',
          summary: `Asked for Opus (${reason}): ${note}`.slice(
            0,
            CARD_SUMMARY_MAX,
          ),
        },
        BOARD_SYSTEM_ACTOR,
      );
    }
    // D10: a person's model is not overruled; the card waits with Run on Opus.
    const relaunched = card.model === null;
    await this.audit.record({
      actor: SYSTEM_ACTOR,
      action: 'card.escalated',
      target: { type: 'board_card', id: card.id },
      projectId: project.id,
      after: {
        number: card.number,
        round: round.round,
        reason,
        model: run.model,
        relaunched,
      },
      result: 'ok',
    });
    this.work.publish(project.id, card.id);
    if (relaunched) {
      const permissionMode = permissionModeOf(run.args);
      setImmediate(() => {
        void this.relaunch(project.id, card.number, permissionMode);
      });
    }
    return { number: card.number, relaunched };
  }

  /**
   * #750 D9: the `escalation` round — the budget gate and the agent limit
   * apply as for any start. A refusal is kept on the card like a refused
   * auto-run, and the card waits in Finished for a person's Run on Opus.
   */
  private async relaunch(
    projectId: string,
    number: number,
    permissionMode: OrchestratorPermissionMode | undefined,
  ): Promise<void> {
    let cardId: string | null = null;
    try {
      const card = await this.work.card(projectId, number);
      cardId = card.id;
      await this.start(
        card,
        'escalation',
        permissionMode ? { permissionMode } : {},
        null,
        BOARD_SYSTEM_ACTOR,
      );
    } catch (error) {
      const { code, message } = autoRunFailureOf(error);
      this.logger.warn(
        `escalation round of ${cardLabel(number)} refused: ${message}`,
      );
      if (cardId === null) return;
      await this.prisma.boardCard.update({
        where: { id: cardId },
        data: {
          autoRunError: code,
          autoRunMessage: message,
          autoRunFailedAt: new Date(),
        },
      });
      await this.audit.record({
        actor: SYSTEM_ACTOR,
        action: 'card.auto_run_failed',
        target: { type: 'board_card', id: cardId },
        projectId,
        // `code` is a redacted audit key: the refusal goes as `error`.
        after: { number, error: code, reason: 'escalation' },
        result: 'error',
        meta: { message },
      });
      this.work.publish(projectId, cardId);
    }
  }

  /**
   * #447 D10: makes a round whose session died resumable again, before
   * Steward sends `card.resume`. Still active: nothing to undo (`active`).
   * Ended by its session alone (`finishedBy: session_end`) while the card is
   * still In progress — a shipping card finishes in place — it is `starting`
   * again with its run live (`reopened`), so the runner's `running` moves it
   * on. Anything else is `refused`: a newer round, a person's stop
   * (`cancelled`), a worker's or a person's finish, a card the work moved on.
   */
  async reopenForResume(
    roundId: string,
  ): Promise<'active' | 'reopened' | 'refused'> {
    const found = await this.prisma.boardCardRound.findUnique({
      where: { id: roundId },
      select: { cardId: true, runId: true },
    });
    if (!found) return 'refused';
    const outcome = await this.prisma.$transaction(async (tx) => {
      const card = await this.work.lock(tx, found.cardId);
      const latest = card.rounds[0];
      if (!latest || latest.id !== roundId) return 'refused';
      if (isActiveRoundPhase(latest.phase)) return 'active';
      if (
        latest.phase !== 'finished' ||
        latest.finishedBy !== 'session_end' ||
        card.column !== 'in_progress'
      ) {
        return 'refused';
      }
      const { count } = await tx.boardCardRound.updateMany({
        where: { id: roundId, phase: 'finished', finishedBy: 'session_end' },
        data: {
          phase: 'starting',
          finishedAt: null,
          finishedBy: null,
          endedAt: null,
          exitCode: null,
        },
      });
      if (count === 0) return 'refused';
      await tx.run.update({
        where: { id: latest.runId },
        data: {
          status: 'running',
          endedAt: null,
          durationMs: null,
          updatedAt: new Date(),
        },
      });
      return 'reopened';
    });
    if (outcome === 'reopened') {
      const card = await this.prisma.boardCard.findUniqueOrThrow({
        where: { id: found.cardId },
        select: { projectId: true },
      });
      this.work.publishRun(card.projectId, found.runId, 'running');
      this.work.publish(card.projectId, found.cardId);
    }
    return outcome;
  }

  /**
   * #447 D10: a reopened round whose resume did not start goes back to how
   * its session left it — finished by the session's end.
   */
  async revertResume(roundId: string): Promise<void> {
    const round = await this.prisma.boardCardRound.findUnique({
      where: { id: roundId },
      select: { runId: true, card: { select: { id: true, projectId: true } } },
    });
    if (!round) return;
    const ended = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const done = await this.work.endRound(tx, roundId, 'finished', now, {
        finishedBy: 'session_end',
        endedAt: now,
      });
      if (done) await this.work.closeRun(tx, round.runId, 'succeeded');
      return done;
    });
    if (ended) {
      this.work.publishRun(round.card.projectId, round.runId, 'succeeded');
      this.work.publish(round.card.projectId, round.card.id);
    }
  }

  private running(): BoardFailure {
    return boardError(
      409,
      BOARD_ERROR.cardRunning,
      'A worker is already running on this card',
    );
  }

  private async start(
    card: CardWithRounds,
    trigger: CardRoundTrigger,
    dto: RunBoardCardDto,
    feedback: string | null,
    actor: BoardActor,
    /** #309 D3: pending uploads that come with the feedback. */
    claimIds: readonly string[] = [],
    /** #359 D6, #884: why a `ci_fix` or `review_fix` round starts. */
    fix: RoundFix | null = null,
    /** #443: the accepted dependency an Auto-run when ready round starts after. */
    autoRunAfter: number | null = null,
    /** #636: the dependency a Run stacks the card on; `null` is the base. */
    stacked: StackedBase | null = null,
    /** #854: the branch a session-gone taken card was worked on. */
    taken: string | null = null,
  ): Promise<void> {
    const project = await this.work.project(card.projectId);
    if (isActiveRoundPhase(card.rounds[0]?.phase)) throw this.running();
    // #359: the runner pushes during the round and opens a draft PR (D1).
    const ships =
      card.source !== 'fleet' &&
      card.source !== 'terminal' &&
      this.commands.servesChecks(project.runnerId);

    const settings = await this.prisma.projectOrchestratorSettings.findUnique({
      where: { projectId: project.id },
      select: { model: true, permissionMode: true },
    });
    // #322 D2, D9: the launch's profile, else the card's; else #272 D1 — the
    // orchestrator's profile, else the project default.
    const profile = await this.profiles.require(
      project,
      { key: dto.profileKey ?? card.profileKey },
      (details, message) =>
        boardError(422, BOARD_ERROR.noProfile, message, details),
    );
    const permissionMode: OrchestratorPermissionMode =
      dto.permissionMode ??
      settings?.permissionMode ??
      ORCHESTRATOR_DEFAULTS.permissionMode;
    // #750 D9: an `escalation` round continues the round a person started,
    // in its mode. C-181: a `ci_fix` round is checked like any other, against
    // the person it runs as.
    if (
      permissionMode === 'bypassPermissions' &&
      actor.role !== 'admin' &&
      trigger !== 'escalation'
    ) {
      throw new ForbiddenException(
        '`bypassPermissions` needs the admin role on the project',
      );
    }

    // #636: a Run that opens a new PR chooses its base — the dependency's
    // branch it is stacked on, else the project base; a card with an open
    // PR, and every other round, keeps the base the card has.
    const choosesBase =
      trigger === 'run' &&
      (card.prNumber === null ||
        card.mergedAt !== null ||
        card.prState === 'closed');
    // #709: a kept base whose dependency has merged — on GitHub, unseen —
    // is moved onto the project base first.
    const keptBase =
      !choosesBase &&
      card.prBaseCardId !== null &&
      !(await this.work.retargetIfDue(project, card))
        ? null
        : card.prBase;
    const base = choosesBase
      ? (stacked?.branch ?? project.base)
      : (keptBase ?? project.base);
    // A session is resumed once Claude has run in it (D5); a round 1 that
    // never started is started again.
    const resume =
      card.sessionId !== null &&
      card.rounds.some((r) => !UNSTARTED_PHASES.has(r.phase));
    // #379: the docs source's Spec folder, else `orchestrator.specDir`.
    const target = resolveSpecTarget(project);
    const specDir = target.kind === 'code_repo' ? target.specDir : null;
    const firstStart = !resume;
    // #243 D6: a needed design is approved before the worker starts.
    const design = trigger === 'run' ? await this.approvedDesign(card) : null;
    // #480: the card's stack — its place, and its approved design as reference.
    const stack = firstStart ? await this.stacks.contextOf(card.id) : null;
    // #359 D4: every card gets its spec file where there is a place for it;
    // without one (#379: no Spec folder, or a remote docs repository with no
    // local clone) it runs without, as readiness says.
    const writesSpec = firstStart && card.specPath === null;
    if (writesSpec && target.kind === 'docs_repo') {
      this.commands.assertReady(project.runnerId, 'docs.publish_specs');
    }

    this.commands.assertReady(project.runnerId, 'card.run');
    await this.assertRoom(project.id);
    await this.attachments.assertClaimable(
      project.id,
      card.id,
      claimIds,
      actor,
    );
    // D13: a hard-stop budget refuses with 409 `budget_exceeded`.
    await this.budgets?.assertAllowed({
      projectId: project.id,
      userId: actor.userId,
    });

    // #746 D2: the card's technique arms, drawn at its first round and
    // sticky — after every refusal, so a refused launch draws nothing.
    const flags = await this.economy.cardFlags(
      project.id,
      card.id,
      card.rounds.length === 0,
    );
    const byType = flags[MODEL_BY_TYPE] === true;
    const capabilities = await this.capabilitiesOf(project.runnerId);
    // #322 D2: the launch's model, else the card's, else the recommendation.
    // #663: the effort beside it the same way; a `ci_fix` round defaults to
    // `sonnet` at `low` (ADR-0068 §5). #750 D3: in the B arm of
    // `model-by-type`, the class mapping instead of the recommendation.
    const defaults = defaultCardLaunch(
      trigger === 'ci_fix',
      cardRecommendationOf(card).work,
      settings?.model,
      byType
        ? { workClass: await this.assessor.currentWorkClass(card.id) }
        : null,
    );
    // #750 D9: an escalation runs on `opus` at `high`, whatever was chosen.
    const escalation = trigger === 'escalation';
    const model = escalation
      ? CARD_ESCALATION_LAUNCH.model
      : (dto.model ?? card.model ?? defaults.model);
    // #663: only a runner that advertises `cardEffort` takes the field.
    const effort =
      capabilities !== null && cardEffortAvailable(capabilities)
        ? escalation
          ? CARD_ESCALATION_LAUNCH.effort
          : (dto.effort ?? card.effort ?? defaults.effort)
        : null;
    // #322 D3: a choice is remembered only when it differs from the default.
    const remembered = {
      model: rememberedChoice(dto.model, defaults.model),
      effort: rememberedChoice(dto.effort, defaults.effort),
      profileKey: rememberedChoice(
        dto.profileKey,
        dto.profileKey === undefined
          ? null
          : await this.defaultProfileKey(project),
      ),
    };

    // D2: the issue first, so the branch can name it (D5). #359 D4: a bug
    // gets one — also when the model chose the kind; a feature none. Without
    // a spec directory there is no spec file, and an issue holds the spec.
    let issue = { number: card.issueNumber, url: card.issueUrl };
    const wantsIssue =
      card.issueOnRun || (card.kindSource === 'auto' && card.kind === 'bug');
    if (firstStart && wantsIssue && issue.number === null) {
      const created = boardOutput(
        'issue.create',
        await this.commands.createIssue(
          project.runnerId,
          {
            projectId: project.id,
            title: card.title,
            body: cardIssueBody(card.body, card.number),
            labels: [card.kind === 'bug' ? 'bug' : 'enhancement'],
            queue: false,
          },
          { role: actor.role, ctx: actor.ctx },
        ),
      );
      issue = { number: created.number, url: created.url };
      await this.prisma.boardCard.update({
        where: { id: card.id },
        data: { issueNumber: issue.number, issueUrl: issue.url },
      });
    }

    // #359 D8: after a merge, the round works on a fresh branch from the
    // updated base, and opens the card's next PR.
    const followUp = ships && resume && card.mergedAt !== null;
    const branch = followUp
      ? await this.followUpBranch(card)
      : (card.branch ??
        cardBranch({
          kind: card.kind,
          number: card.number,
          title: card.title,
          issueNumber: issue.number,
        }));
    // #854 D1: a session-gone taken card's Run starts on the branch the
    // session worked — when it is a card branch and the runner takes the
    // field; the runner then uses it only when origin has it.
    const startChoice = startBranchChoice(
      taken,
      branch,
      followUp,
      capabilities !== null && cardStartBranchAvailable(capabilities),
    );
    const startBranch =
      startChoice?.kind === 'send' ? startChoice.branch : null;
    // #379: a spec in an external docs repository goes in through its own
    // pull request, before the worker starts; the card's branch never holds it.
    let specPr = cardSpecPrOf(card);
    if (writesSpec && target.kind === 'docs_repo') {
      specPr = await this.publishSpec(project, card, target, issue, actor);
    }
    const specPath =
      specPr?.path ??
      card.specPath ??
      (specDir
        ? cardSpecPath(specDir, {
            number: card.number,
            title: card.title,
            issueNumber: issue.number,
          })
        : null);
    // #243 D7, #441: round 1 commits every frame of the approved variant
    // into the card's branch, as stored — without the viewer's pin helper,
    // which is never stored.
    const designFrames: (CardRunFile & { name: string })[] =
      firstStart && design
        ? design.frames.map((f) => ({
            name: f.name,
            path: cardDesignPath(
              specDir,
              {
                number: card.number,
                title: card.title,
                issueNumber: issue.number,
              },
              design.variant,
              f.slug,
            ),
            content: f.html,
          }))
        : [];
    // #480: round 1 commits the stack's approved design beside the card's own.
    const stackFrames: (CardRunFile & { name: string })[] = stack?.design
      ? stack.design.frames.map((f) => ({
          name: f.name,
          path: stackDesignPath(
            specDir,
            stack,
            stack.design?.variant ?? 1,
            f.slug,
          ),
          content: f.html,
        }))
      : [];
    const sessionId = card.sessionId ?? randomUUID();
    // #309 D9, D10: what the card holds once this round's claim is made.
    const attached = await this.attachments.withClaim(card.id, claimIds);
    const attachmentRefs = attached.map(toAttachmentRef);
    const attachmentBriefs = attached.map(toAttachmentBrief);
    // #445 D11: only a runner that advertises the token saver gets the field.
    // Before the prompt: #747 D10 puts the `terse-register` arm in it.
    const saver = await this.tokenSaver.launch(project.id, flags);
    // #750 D7: a resumed session keeps the model and effort it started with;
    // another pair starts a fresh session from the handoff. A null pair
    // (before #750) matches. A runner without `cardFreshStart` resumes.
    const fresh =
      resume &&
      card.sessionModel !== null &&
      (card.sessionModel !== model || card.sessionEffort !== effort) &&
      capabilities !== null &&
      cardFreshStartAvailable(capabilities);
    // #751 S2: the session's frozen prefix — card type, selection, compressed
    // rules, overlays. A resumed session keeps what it started with; a new or
    // fresh one takes the settings and approvals as they are now. C-227: the
    // rules section is read at dispatch, so an edit reaches the next session.
    const prefix = await this.prefixLaunch.resolve({
      projectId: project.id,
      card,
      ciFix: trigger === 'ci_fix',
      reuse: resume && !fresh,
      flags,
      mcpAllow: saver.args.tokenSaver?.mcpAllow ?? null,
      capabilities,
    });
    const projectRules = prefix.projectRules;
    // #750 D8: a non-Opus round of the B arm may ask for Opus, once.
    const escalate =
      byType &&
      !isOpusModel(model) &&
      card.escalatedAt === null &&
      capabilities !== null &&
      cardEscalateAvailable(capabilities);
    const demo = cardRoundDemo(
      card,
      await this.demoSettings(project.id),
      capabilities,
    );
    const nextRound = (change: CardChange | null) =>
      cardNextRoundPrompt({
        label: cardLabel(card.number),
        change,
        feedback: trigger === 'feedback' ? feedback : null,
      });
    // #750 D9: an escalation resumes the card's work, with the finding.
    const nextPrompt = nextRound(changeSinceLastRound(card, attachmentBriefs));
    const prompt = fix
      ? fix.reason === 'review'
        ? cardReviewFixPrompt(fix)
        : cardCiFixPrompt(fix)
      : resume || (trigger === 'feedback' && feedback !== null)
        ? escalation
          ? escalationRoundPrompt(card, nextPrompt, nextRound(null))
          : nextPrompt
        : cardWorkerPrompt({
            number: card.number,
            title: card.title,
            body: card.body,
            kind: card.kind,
            // #854: the branch the round is expected to work on.
            branch: startBranch ?? branch,
            base,
            specPath,
            specPr: specPr
              ? { repo: specPr.repo, url: specPr.url, branch: specPr.branch }
              : null,
            issueNumber: issue.number,
            design:
              designFrames.length > 0 && design
                ? {
                    frames: designFrames.map((f) => ({
                      name: f.name,
                      path: f.path,
                    })),
                    rationale: design.rationale,
                    comments: design.comments,
                  }
                : null,
            stack: stack
              ? {
                  label: stackLabel(stack.number),
                  title: stack.title,
                  stage: stack.stage,
                  stageTitle: stack.stageTitle,
                  stageCount: stack.stageCount,
                  design:
                    stack.design && stackFrames.length > 0
                      ? {
                          frames: stackFrames.map((f) => ({
                            name: f.name,
                            path: f.path,
                          })),
                          rationale: stack.design.rationale,
                        }
                      : null,
                }
              : null,
            attachments: attachmentBriefs,
            projectRules,
            ...cardPromptSaver(saver),
            // #750 D8: the text goes with the tool the runner offers.
            ...cardPromptEscalate(escalate),
            demo,
          });
    const files: CardRunFile[] = [
      ...(firstStart && specPath !== null && specPr === null
        ? [{ path: specPath, content: specContent(card, issue.number) }]
        : []),
      ...designFrames.map((f) => ({ path: f.path, content: f.content })),
      ...stackFrames.map((f) => ({ path: f.path, content: f.content })),
    ];
    const draft: Omit<CardRunArgs, 'runId'> = {
      cardId: card.id,
      projectId: project.id,
      root: project.rootPath,
      base,
      shortId: card.shortId,
      branch,
      session: { id: sessionId, resume, ...(fresh ? { fresh } : {}) },
      prompt,
      ...(files.length > 0 ? { files } : {}),
      // Absent is none: the runner then prunes what an earlier round left.
      ...(attachmentRefs.length > 0 ? { attachments: attachmentRefs } : {}),
      profileKey: profile.key,
      model,
      ...(effort !== null ? { effort } : {}),
      permissionMode,
      ...(ships
        ? {
            pullRequest: cardDraftPullRequest({
              number: card.number,
              title: card.title,
              issueNumber: issue.number,
            }),
          }
        : {}),
      ...(followUp ? { newBranch: true } : {}),
      ...(escalate ? { escalate: true as const } : {}),
      ...(startBranch !== null ? { startBranch } : {}),
      ...(demo !== null ? { demo: true as const } : {}),
      ...withCardPrefix(saver.args, prefix.prefix),
    };
    const valid = cardRunArgsSchema.safeParse({ ...draft, runId: 'pending' });
    if (!valid.success) {
      throw new BadRequestException(
        `The round cannot start: ${z.prettifyError(valid.error)}`,
      );
    }

    const now = new Date();
    const round = await this.prisma.$transaction(async (tx) => {
      await this.lockRoom(tx, project.id);
      const fresh = await this.work.lock(tx, card.id);
      const latest = fresh.rounds[0];
      if (isActiveRoundPhase(latest?.phase)) throw this.running();
      await this.assertRoom(project.id, tx);
      const next = (latest?.round ?? 0) + 1;
      const run = await tx.run.create({
        data: {
          kind: 'card',
          projectId: project.id,
          issue: issue.number,
          title: `${cardLabel(card.number)} ${card.title}`.slice(0, 200),
          runtime: profile.runtime,
          model,
          profileKey: profile.key,
          args: {
            card: card.number,
            round: next,
            trigger,
            promptVersion: CARD_WORKER_PROMPT_VERSION,
            // #663: what the round ran at; `null` is the CLI's default.
            effort,
            // #447 DA-15: Steward resumes the round in the mode it started in.
            permissionMode,
          },
          tokenSaver: saver.on,
          // #746 D11: the flags launched; reports read this snapshot.
          techniques: saver.techniques ?? Prisma.DbNull,
          // #751 B4: the session's card type, for the report.
          cardType: prefix.cardType,
          status: 'running',
          triggeredByType: 'user',
          triggeredById: actor.userId,
          startedAt: now,
          updatedAt: now,
        },
        select: { id: true },
      });
      const created = await tx.boardCardRound.create({
        data: {
          cardId: card.id,
          round: next,
          runId: run.id,
          trigger,
          autoRunAfter,
          feedback,
          cardTitle: card.title,
          cardBody: card.body,
          cardKind: card.kind,
          cardAttachments: attachmentBriefs,
          // C-181: a `ci_fix` round runs as a person but is Nautelle's own;
          // #884: so is a `review_fix` round.
          authorId: isFixRound(trigger) ? null : actor.userId,
          phase: 'queued',
          startedAt: now,
          // #542: the head the round starts on; a follow-up starts a new PR.
          startHeadSha:
            !followUp && fresh.prNumber !== null ? fresh.ciHeadSha : null,
          // #449 D3: the session it launches with; a `fresh` start replaces
          // it (`round.restart`), and the earlier rounds keep theirs.
          sessionId,
        },
      });
      await this.attachments.claim(
        tx,
        { projectId: project.id, cardId: card.id, roundId: created.id },
        claimIds,
        actor,
      );
      await tx.boardCard.update({
        where: { id: card.id },
        data: {
          sessionId,
          // #750 D7: the pair this round's session runs at.
          sessionModel: model,
          sessionEffort: effort,
          // #751 S2: frozen with the session it starts.
          ...(prefix.started
            ? {
                sessionCardType: prefix.cardType,
                sessionPrefix: prefix.session,
              }
            : {}),
          branch,
          specPath,
          ...(choosesBase
            ? {
                prBase: stacked?.branch ?? null,
                prBaseCardId: stacked?.cardId ?? null,
              }
            : {}),
          ...(remembered.model !== undefined
            ? { model: remembered.model }
            : {}),
          ...(remembered.effort !== undefined
            ? { effort: remembered.effort }
            : {}),
          ...(remembered.profileKey !== undefined
            ? { profileKey: remembered.profileKey }
            : {}),
          // #273 D9: a round started; an earlier auto-run failure is history.
          autoRunError: null,
          autoRunMessage: null,
          autoRunFailedAt: null,
          // #359 D6: one of the PR's fix attempts; a person's round is the
          // person acting, so automation resumes.
          ...(trigger === 'ci_fix'
            ? { ciFixAttempts: { increment: 1 } }
            : trigger === 'review_fix'
              ? { reviewFixAttempts: { increment: 1 } }
              : { needsPerson: false, needsPersonReason: null }),
          // #359 D8: the next PR starts with nothing of the merged one.
          ...(followUp
            ? {
                prNumber: null,
                prUrl: null,
                prState: null,
                mergedAt: null,
                ciState: 'none' as const,
                ciChecks: Prisma.DbNull,
                ciHeadSha: null,
                ciCheckedAt: null,
                ciFixAttempts: 0,
                reviewFixAttempts: 0,
                ciNoneSince: null,
                ciRetriggeredSha: null,
              }
            : {}),
        },
      });
      return created;
    });
    this.work.publishRun(project.id, round.runId, 'running');
    await this.attachments.recordClaim(
      project.id,
      { cardId: card.id, roundId: round.id },
      claimIds,
      actor,
    );
    // #271 D3: this round reads the feedback as typed; later reads get English.
    if (feedback !== null) {
      await this.text.request(
        project.id,
        { ownerType: 'board_card_round', ownerId: round.id },
        [{ field: 'feedback', text: feedback }],
        { authorId: actor.userId },
      );
    }

    // The work moves the card (D7: Run → In progress is automatic).
    const moved = await this.work.card(project.id, card.number);
    if (moved.column !== 'in_progress') {
      await this.work.move(
        project,
        moved,
        { to: 'in_progress', index: 0, source: 'automatic' },
        BOARD_SYSTEM_ACTOR,
      );
    }

    const after = {
      number: card.number,
      round: round.round,
      runId: round.runId,
      trigger,
      ...(fix
        ? fix.reason === 'review'
          ? { reviewFix: fix.findings.length }
          : { ciFix: fix.reason }
        : {}),
      ...(autoRunAfter !== null ? { autoRunAfter } : {}),
      branch,
      ...(followUp ? { newBranch: true } : {}),
      resume,
      ...(fresh ? { fresh } : {}),
      ...(escalate ? { escalate } : {}),
      profileKey: profile.key,
      model,
      effort,
      permissionMode,
      issueNumber: issue.number,
      specPath,
    };
    try {
      const output = boardOutput(
        'card.run',
        await this.commands.send(
          project.runnerId,
          'card.run',
          { ...draft, runId: round.runId },
          {
            role: actor.role,
            ctx: actor.ctx,
            // The prompt and the spec are the card's text: not verbatim in audit.
            auditArgs: {
              ...draft,
              runId: round.runId,
              prompt: `[${prompt.length} chars]`,
              ...(files.length > 0
                ? { files: files.map((f) => ({ path: f.path })) }
                : {}),
              // Names are the person's text too: ids and hashes only.
              ...(attachmentRefs.length > 0
                ? {
                    attachments: attachmentRefs.map((a) => ({
                      id: a.id,
                      sha256: a.sha256,
                    })),
                  }
                : {}),
            },
          },
        ),
      );
      // Events may already have moved it on; never step back.
      await this.prisma.boardCardRound.updateMany({
        where: { id: round.id, phase: 'queued' },
        data: { phase: output.phase, tmuxSession: output.tmuxSession },
      });
      await this.prisma.boardCardRound.updateMany({
        where: { id: round.id, tmuxSession: null },
        data: { tmuxSession: output.tmuxSession },
      });
      // #854 D2: on the taken branch now, the card continues it from here.
      const onBranch = output.branch ?? branch;
      if (taken !== null && onBranch === taken) {
        await this.prisma.boardCard.update({
          where: { id: card.id },
          data: { branch: taken, takenBranch: null },
        });
      }
      await this.record(
        trigger,
        actor,
        project.id,
        card.id,
        {
          ...after,
          ...(taken !== null
            ? {
                branch: onBranch,
                takenBranch: taken,
                ...startBranchOutcome(startChoice, output.startBranchSkipped),
              }
            : {}),
        },
        'ok',
      );
    } catch (error) {
      if (!(error instanceof BoardFailure)) throw error;
      // No answer: the runner may have started it; its events settle it.
      if (error.statusCode !== 504) {
        await this.prisma.$transaction(async (tx) => {
          if (
            await this.work.endRound(tx, round.id, 'failed', new Date(), {
              error: error.message,
            })
          ) {
            await this.work.closeRun(tx, round.runId, 'failed', error.message);
          }
        });
        this.work.publishRun(project.id, round.runId, 'failed');
      }
      await this.record(trigger, actor, project.id, card.id, after, 'error', {
        error: error.code,
      });
      this.work.publish(project.id, card.id);
      throw error;
    }
    this.work.publish(project.id, card.id);
  }

  /**
   * #243 D6, D7: the card's approved design for round 1 — `null` when the
   * card has none or it is off; 409 `design_not_approved` while a needed
   * design is not approved. #441: every frame of it, in order. The comments
   * are the bodies the approved variant's revisions addressed, oldest first
   * — the review's decisions — each led by its frame's name when the design
   * has several.
   */
  /**
   * #379: `docs.publish_specs` — the card's spec on `docs/card-<shortId>` of
   * the docs repository, as a pull request there. Its body names the code
   * issue, so GitHub links the two. Stored at once, like the issue: a Run
   * that fails later does not publish again.
   */
  private async publishSpec(
    project: BoardProject,
    card: CardWithRounds,
    target: Extract<SpecTarget, { kind: 'docs_repo' }>,
    issue: { number: number | null; url: string | null },
    actor: BoardActor,
  ): Promise<CardSpecPr> {
    const path = cardSpecPath(target.specDir, {
      number: card.number,
      title: card.title,
      issueNumber: issue.number,
    });
    const branch = cardDocsBranch(card.shortId);
    const label = cardLabel(card.number);
    const published = boardOutput(
      'docs.publish_specs',
      await this.commands.publishDocsSpecs(
        project.runnerId,
        {
          projectId: project.id,
          root: project.rootPath,
          docsRoot: target.docsRoot,
          specDir: target.specDir,
          branch,
          files: [{ path, content: specContent(card, issue.number) }],
          title: `docs(specs): ${label} ${card.title}`.slice(
            0,
            ISSUE_TITLE_MAX,
          ),
          body: cardSpecPrBody({
            number: card.number,
            title: card.title,
            repo: project.repo,
            issueNumber: issue.number,
          }),
        },
        { role: actor.role, ctx: actor.ctx },
      ),
    );
    await this.prisma.boardCard.update({
      where: { id: card.id },
      data: {
        specPath: path,
        specRepo: published.repo,
        specPrNumber: published.prNumber,
        specPrUrl: published.prUrl,
      },
    });
    return {
      path,
      repo: published.repo,
      number: published.prNumber,
      url: published.prUrl,
      branch,
    };
  }

  private async approvedDesign(card: CardWithRounds): Promise<{
    variant: number;
    frames: FrameFile[];
    rationale: string;
    comments: string[];
  } | null> {
    const design = await this.prisma.taskDesign.findUnique({
      where: { cardId: card.id },
      select: {
        id: true,
        needed: true,
        status: true,
        approvedRevision: {
          select: { id: true, variant: true, rationale: true },
        },
      },
    });
    if (!design?.needed) return null;
    const approved = design.approvedRevision;
    if (design.status !== 'approved' || !approved) {
      throw boardError(
        409,
        BOARD_ERROR.designNotApproved,
        `The design of ${cardLabel(card.number)} is not approved yet`,
      );
    }
    const comments = await this.prisma.designComment.findMany({
      where: {
        designId: design.id,
        addressedIn: { variant: approved.variant },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        body: true,
        frame: true,
        revision: { select: { frames: frameNameSelect } },
      },
    });
    const frames = await revisionFrames(this.prisma, approved.id);
    return {
      variant: approved.variant,
      rationale: approved.rationale,
      frames,
      comments: comments.map((c) => {
        if (frames.length === 1) return c.body;
        const frame = frameNamesOf(c.revision.frames)[c.frame];
        return frame ? `${frame.name}: ${c.body}` : c.body;
      }),
    };
  }

  /**
   * #359 D8: the branch of the card's next PR — `cardFollowUpBranch` of its
   * first PR's branch (the card's own), `k` one past the PRs it has.
   */
  private async followUpBranch(card: CardWithRounds): Promise<string> {
    const prs = await this.prisma.boardCardPullRequest.findMany({
      where: { cardId: card.id },
      orderBy: { createdAt: 'asc' },
      select: { branch: true },
    });
    const first =
      prs[0]?.branch ??
      card.branch ??
      cardBranch({
        kind: card.kind,
        number: card.number,
        title: card.title,
        issueNumber: card.issueNumber,
      });
    return cardFollowUpBranch(first, Math.max(prs.length, 1) + 1);
  }

  /** #663: whether the project's runner advertises `cardEffort`. */
  /** The runner's capability advert (ADR-0023); `null` when unreadable. */
  private async capabilitiesOf(runnerId: string): Promise<Capabilities | null> {
    const runner = await this.prisma.runner.findUnique({
      where: { id: runnerId },
      select: { capabilities: true },
    });
    const capabilities = capabilitiesSchema.safeParse(runner?.capabilities);
    return capabilities.success ? capabilities.data : null;
  }

  /** #322 D3: the profile #272 D1 picks without a card or launch key. */
  private async defaultProfileKey(
    project: BoardProject,
  ): Promise<string | null> {
    const pick = await this.profiles.resolve(project);
    return pick.ok ? pick.profile.key : null;
  }

  /** Serializes round starts of one project, so `maxRunning` holds. */
  private async lockRoom(tx: Tx, projectId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`board-rounds:${projectId}`}))`;
  }

  /** D13: at most `maxRunning` active rounds per project → else 409 `max_running`. */
  private async assertRoom(
    projectId: string,
    db: Tx | PrismaService = this.prisma,
  ): Promise<void> {
    const [settings, active] = await Promise.all([
      db.boardSettings.findUnique({ where: { projectId } }),
      db.boardCardRound.count({
        where: { phase: { in: ACTIVE_PHASES }, card: { projectId } },
      }),
    ]);
    const { maxRunning } = toSettingsView(projectId, settings);
    if (active >= maxRunning) {
      throw boardError(
        409,
        BOARD_ERROR.maxRunning,
        `${active} of ${maxRunning} card workers are running in this project`,
      );
    }
  }

  private record(
    trigger: CardRoundTrigger,
    actor: BoardActor,
    projectId: string,
    cardId: string,
    after: object,
    result: 'ok' | 'error',
    meta?: object,
  ) {
    return this.audit.record({
      ...actor.ctx,
      action: trigger === 'feedback' ? 'card.feedback' : 'card.run_started',
      target: { type: 'board_card', id: cardId },
      projectId,
      after,
      result,
      ...(meta ? { meta } : {}),
    });
  }
}
