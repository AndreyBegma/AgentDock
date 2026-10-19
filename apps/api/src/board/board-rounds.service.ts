import { randomUUID } from 'node:crypto';
import {
  BOARD_ERROR,
  type BoardCardDetail,
  CARD_WORKER_PROMPT_VERSION,
  type CardAttachmentBrief,
  type CardChange,
  type CardCiFixInput,
  type CardRoundPhase,
  type CardRoundTrigger,
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
  cardSpecPath,
  cardSpecPrBody,
  cardWorkerPrompt,
  isActiveRoundPhase,
  PROJECT_RULES_BLOCK_MAX_BYTES,
  projectRulesBlock,
  stackDesignPath,
  stackLabel,
} from '@agentdock/shared';
import {
  type CardRunArgs,
  type CardRunFile,
  capabilitiesSchema,
  cardDocsBranch,
  cardEffortAvailable,
  cardRunArgsSchema,
  ISSUE_TITLE_MAX,
  ORCHESTRATOR_DEFAULTS,
  type OrchestratorPermissionMode,
} from '@agentdock/shared/protocol';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  AttachmentsService,
  toAttachmentBrief,
  toAttachmentRef,
} from '../attachments/attachments.service';
import { AuditService } from '../audit/audit.service';
import { BudgetGate } from '../budgets/budget-gate';
import { PrismaService } from '../database/prisma.service';
import {
  type FrameFile,
  frameNameSelect,
  frameNamesOf,
  revisionFrames,
} from '../design/design-store';
import { resolveSpecTarget, type SpecTarget } from '../planner/spec-target';
import { RuntimeProfileResolver } from '../readiness';
import { TextNormalizer } from '../text/text-normalizer';
import { TokenSaverService } from '../token-saver/token-saver.service';
import { BoardService } from './board.service';
import { BoardCommands, boardOutput } from './board-commands';
import {
  BoardDependencies,
  type StackedBase,
} from './board-dependencies.service';
import { BoardFailure, boardError } from './board-error';
import type { CardWithRounds } from './board-mapper';
import { toSettingsView } from './board-mapper';
import { BoardStacks } from './board-stacks';
import {
  ACTIVE_PHASES,
  BOARD_SYSTEM_ACTOR,
  type BoardActor,
  type BoardProject,
  BoardWork,
} from './board-work';
import type { CardFeedbackDto, RunBoardCardDto } from './dto';
import { defaultCardLaunch, rememberedChoice } from './launch-choice';

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
    @Optional() private readonly budgets?: BudgetGate,
  ) {}

  /**
   * `POST …/run`: round 1, or a retry after failed / ended / cancelled.
   * #443: Auto-run when ready calls it too, as the person who accepted the
   * last open dependency, with `autoRunAfter` that dependency's number.
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
    );
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
   * #359 D6: AgentDock's own round for a red check or a merge conflict on
   * the card's PR — the system actor, the card's session resumed, the
   * `ci_fix` prompt. Counts one of the PR's `ci_fix` attempts. Refused like
   * any round (running, no room, budget); the poller tries again.
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
    await this.start(card, 'ci_fix', {}, null, BOARD_SYSTEM_ACTOR, [], input);
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
    /** #359 D6: why a `ci_fix` round starts. */
    ciFix: CardCiFixInput | null = null,
    /** #443: the accepted dependency an Auto-run when ready round starts after. */
    autoRunAfter: number | null = null,
    /** #636: the dependency a Run stacks the card on; `null` is the base. */
    stacked: StackedBase | null = null,
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
    // #359 D6: a `ci_fix` round runs as the project's admin configured it.
    if (
      permissionMode === 'bypassPermissions' &&
      actor.role !== 'admin' &&
      trigger !== 'ci_fix'
    ) {
      throw new ForbiddenException(
        '`bypassPermissions` needs the admin role on the project',
      );
    }
    // #322 D2: the launch's model, else the card's, else the recommendation.
    // #663: the effort beside it the same way; a `ci_fix` round defaults to
    // `sonnet` at `low` (ADR-0068 §5).
    const defaults = defaultCardLaunch(
      trigger === 'ci_fix',
      cardRecommendationOf(card).work,
      settings?.model,
    );
    const model = dto.model ?? card.model ?? defaults.model;
    // #663: only a runner that advertises `cardEffort` takes the field.
    const effort = (await this.servesEffort(project.runnerId))
      ? (dto.effort ?? card.effort ?? defaults.effort)
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

    // #636: a Run that opens a new PR chooses its base — the dependency's
    // branch it is stacked on, else the project base; a card with an open
    // PR, and every other round, keeps the base the card has.
    const choosesBase =
      trigger === 'run' &&
      (card.prNumber === null ||
        card.mergedAt !== null ||
        card.prState === 'closed');
    const base = choosesBase
      ? (stacked?.branch ?? project.base)
      : (card.prBase ?? project.base);
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
    const projectRules = await this.projectRulesSection(project.id);
    const prompt = ciFix
      ? cardCiFixPrompt(ciFix)
      : resume || (trigger === 'feedback' && feedback !== null)
        ? cardNextRoundPrompt({
            label: cardLabel(card.number),
            change: changeSinceLastRound(card, attachmentBriefs),
            feedback: trigger === 'feedback' ? feedback : null,
          })
        : cardWorkerPrompt({
            number: card.number,
            title: card.title,
            body: card.body,
            kind: card.kind,
            branch,
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
          });
    const files: CardRunFile[] = [
      ...(firstStart && specPath !== null && specPr === null
        ? [{ path: specPath, content: specContent(card, issue.number) }]
        : []),
      ...designFrames.map((f) => ({ path: f.path, content: f.content })),
      ...stackFrames.map((f) => ({ path: f.path, content: f.content })),
    ];
    // #445 D11: only a runner that advertises the token saver gets the field.
    const saver = await this.tokenSaver.launch(project.id);
    const draft: Omit<CardRunArgs, 'runId'> = {
      cardId: card.id,
      projectId: project.id,
      root: project.rootPath,
      base,
      shortId: card.shortId,
      branch,
      session: { id: sessionId, resume },
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
      ...saver.args,
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
          authorId: actor.userId,
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
      ...(ciFix ? { ciFix: ciFix.reason } : {}),
      ...(autoRunAfter !== null ? { autoRunAfter } : {}),
      branch,
      ...(followUp ? { newBranch: true } : {}),
      resume,
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
  /**
   * C-227: the project's enabled rules as the prompt's section, read now —
   * at dispatch — so an edit or a toggle reaches the next run. `null`
   * without an enabled rule. Oversized rules are cut with a marker and a
   * warning.
   */
  private async projectRulesSection(projectId: string): Promise<string | null> {
    const rules = await this.prisma.projectRule.findMany({
      where: { projectId, enabled: true },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: { title: true, description: true, enabled: true },
    });
    const block = projectRulesBlock(rules);
    if (block.omitted > 0) {
      this.logger.warn(
        `Project ${projectId}: ${block.omitted} of ${rules.length} enabled coding rules did not fit the ${PROJECT_RULES_BLOCK_MAX_BYTES}-byte prompt block and were left out`,
      );
    }
    return block.text;
  }

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
  private async servesEffort(runnerId: string): Promise<boolean> {
    const runner = await this.prisma.runner.findUnique({
      where: { id: runnerId },
      select: { capabilities: true },
    });
    const capabilities = capabilitiesSchema.safeParse(runner?.capabilities);
    return capabilities.success && cardEffortAvailable(capabilities.data);
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
