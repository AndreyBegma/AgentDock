import { randomUUID } from 'node:crypto';
import {
  BOARD_ERROR,
  type BoardCardDetail,
  CARD_WORKER_PROMPT_VERSION,
  type CardChange,
  type CardRoundPhase,
  type CardRoundTrigger,
  cardBranch,
  cardChange,
  cardDesignPath,
  cardIssueBody,
  cardLabel,
  cardNextRoundPrompt,
  cardSpecPath,
  cardWorkerPrompt,
  isActiveRoundPhase,
} from '@agentdock/shared';
import {
  type CardRunArgs,
  type CardRunFile,
  cardRunArgsSchema,
  ORCHESTRATOR_DEFAULTS,
  type OrchestratorPermissionMode,
} from '@agentdock/shared/protocol';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Optional,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { BudgetGate } from '../budgets/budget-gate';
import { PrismaService } from '../database/prisma.service';
import { specDirOf } from '../planner/planner-instructions.service';
import { RuntimeProfileResolver } from '../readiness';
import { BoardService } from './board.service';
import { BoardCommands, boardOutput } from './board-commands';
import { BoardFailure, boardError } from './board-error';
import type { CardWithRounds } from './board-mapper';
import { toSettingsView } from './board-mapper';
import {
  ACTIVE_PHASES,
  BOARD_SYSTEM_ACTOR,
  type BoardActor,
  BoardWork,
} from './board-work';
import type { CardFeedbackDto, RunBoardCardDto } from './dto';

type Tx = Prisma.TransactionClient;

/** D2: the spec the runner commits as the branch's first commit. */
const specContent = (card: CardWithRounds, issueNumber: number | null) =>
  [
    `# ${cardLabel(card.number)}: ${card.title}`,
    '',
    ...(issueNumber !== null ? [`Issue: #${issueNumber}`, ''] : []),
    card.body.trim() || '(no description)',
    '',
  ].join('\n');

/**
 * Phases of a round that never started Claude: still queued, or `failed` —
 * the runner could not start it. Any other round used the session.
 */
const UNSTARTED_PHASES: ReadonlySet<CardRoundPhase> = new Set([
  'queued',
  'failed',
]);

/**
 * #273 D1: how the card's text differs from what the worker was last given —
 * the snapshot of the newest round that started Claude. `null` without one.
 */
const changeSinceLastRound = (card: CardWithRounds): CardChange | null => {
  const last = card.rounds.find((r) => !UNSTARTED_PHASES.has(r.phase));
  if (!last) return null;
  return cardChange(
    { title: last.cardTitle, body: last.cardBody, kind: last.cardKind },
    { title: card.title, body: card.body, kind: card.kind },
  );
};

/**
 * Starting a round (issue #242 D4, D5, D9, D12, D13): Run — round 1 or a
 * retry — and feedback. Everything that can be refused is refused before a
 * row exists or a command is sent; the round is then a `runs` row of kind
 * `card` plus its `board_card_rounds` row, and the card moves to In progress.
 */
@Injectable()
export class BoardRoundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly work: BoardWork,
    private readonly board: BoardService,
    private readonly commands: BoardCommands,
    private readonly audit: AuditService,
    private readonly profiles: RuntimeProfileResolver,
    @Optional() private readonly budgets?: BudgetGate,
  ) {}

  /** `POST …/run`: round 1, or a retry after failed / ended / cancelled. */
  async run(
    projectId: string,
    number: number,
    dto: RunBoardCardDto,
    actor: BoardActor,
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
    await this.start(card, 'run', dto, null, actor);
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
    await this.start(card, 'feedback', {}, dto.text.trim(), actor);
    return this.board.detail(projectId, number);
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
  ): Promise<void> {
    const project = await this.work.project(card.projectId);
    if (isActiveRoundPhase(card.rounds[0]?.phase)) throw this.running();

    const settings = await this.prisma.projectOrchestratorSettings.findUnique({
      where: { projectId: project.id },
      select: { model: true, permissionMode: true },
    });
    // #272 D1: the orchestrator's profile, else the project default.
    const profile = await this.profiles.require(
      project,
      {},
      (details, message) =>
        boardError(422, BOARD_ERROR.noProfile, message, details),
    );
    const permissionMode: OrchestratorPermissionMode =
      dto.permissionMode ??
      settings?.permissionMode ??
      ORCHESTRATOR_DEFAULTS.permissionMode;
    if (permissionMode === 'bypassPermissions' && actor.role !== 'admin') {
      throw new ForbiddenException(
        '`bypassPermissions` needs the admin role on the project',
      );
    }
    const model =
      dto.model ?? card.model ?? settings?.model ?? ORCHESTRATOR_DEFAULTS.model;

    // A session is resumed once Claude has run in it (D5); a round 1 that
    // never started is started again.
    const resume =
      card.sessionId !== null &&
      card.rounds.some((r) => !UNSTARTED_PHASES.has(r.phase));
    const specDir = specDirOf(project.codeSentinelConfig);
    const firstStart = !resume;
    // #243 D6: a needed design is approved before the worker starts.
    const design = trigger === 'run' ? await this.approvedDesign(card) : null;
    if (firstStart && card.specOnRun && card.specPath === null && !specDir) {
      throw boardError(
        422,
        BOARD_ERROR.noSpecDir,
        'The project has no spec directory: set orchestrator.specDir, or turn off the spec',
      );
    }

    this.commands.assertReady(project.runnerId, 'card.run');
    await this.assertRoom(project.id);
    // D13: a hard-stop budget refuses with 409 `budget_exceeded`.
    await this.budgets?.assertAllowed({
      projectId: project.id,
      userId: actor.userId,
    });

    // D2: the issue first, so the branch can name it (D5).
    let issue = { number: card.issueNumber, url: card.issueUrl };
    if (firstStart && card.issueOnRun && issue.number === null) {
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

    const branch =
      card.branch ??
      cardBranch({
        kind: card.kind,
        number: card.number,
        title: card.title,
        issueNumber: issue.number,
      });
    const specPath =
      card.specPath ??
      (card.specOnRun && specDir
        ? cardSpecPath(specDir, {
            number: card.number,
            title: card.title,
            issueNumber: issue.number,
          })
        : null);
    // #243 D7: round 1 commits the approved mockup into the card's branch,
    // as stored — without the viewer's pin helper, which is never stored.
    const designFile: CardRunFile | null =
      firstStart && design
        ? {
            path: cardDesignPath(
              specDir,
              {
                number: card.number,
                title: card.title,
                issueNumber: issue.number,
              },
              design.variant,
            ),
            content: design.html,
          }
        : null;
    const sessionId = card.sessionId ?? randomUUID();
    const prompt =
      resume || (trigger === 'feedback' && feedback !== null)
        ? cardNextRoundPrompt({
            label: cardLabel(card.number),
            change: changeSinceLastRound(card),
            feedback: trigger === 'feedback' ? feedback : null,
          })
        : cardWorkerPrompt({
            number: card.number,
            title: card.title,
            body: card.body,
            kind: card.kind,
            branch,
            base: project.base,
            specPath,
            issueNumber: issue.number,
            design:
              designFile && design
                ? {
                    path: designFile.path,
                    rationale: design.rationale,
                    comments: design.comments,
                  }
                : null,
          });
    const files: CardRunFile[] = [
      ...(firstStart && specPath !== null
        ? [{ path: specPath, content: specContent(card, issue.number) }]
        : []),
      ...(designFile ? [designFile] : []),
    ];
    const draft: Omit<CardRunArgs, 'runId'> = {
      cardId: card.id,
      projectId: project.id,
      root: project.rootPath,
      base: project.base,
      shortId: card.shortId,
      branch,
      session: { id: sessionId, resume },
      prompt,
      ...(files.length > 0 ? { files } : {}),
      profileKey: profile.key,
      model,
      permissionMode,
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
          },
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
          feedback,
          cardTitle: card.title,
          cardBody: card.body,
          cardKind: card.kind,
          authorId: actor.userId,
          phase: 'queued',
          startedAt: now,
        },
      });
      await tx.boardCard.update({
        where: { id: card.id },
        data: {
          sessionId,
          branch,
          specPath,
          ...(dto.model !== undefined ? { model: dto.model } : {}),
          // #273 D9: a round started; an earlier auto-run failure is history.
          autoRunError: null,
          autoRunMessage: null,
          autoRunFailedAt: null,
        },
      });
      return created;
    });
    this.work.publishRun(project.id, round.runId, 'running');

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
      branch,
      resume,
      profileKey: profile.key,
      model,
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
      await this.record(trigger, actor, project.id, card.id, after, 'ok');
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
   * design is not approved. The comments are the bodies the approved
   * variant's revisions addressed, oldest first: the review's decisions.
   */
  private async approvedDesign(card: CardWithRounds): Promise<{
    variant: number;
    html: string;
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
          select: { variant: true, html: true, rationale: true },
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
      select: { body: true },
    });
    return { ...approved, comments: comments.map((c) => c.body) };
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
