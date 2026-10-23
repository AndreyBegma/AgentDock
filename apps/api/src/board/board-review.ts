import { randomUUID } from 'node:crypto';
import {
  BOARD_ERROR,
  type CardNeedsPersonReason,
  type CardReviewFixFinding,
  cardLabel,
  cardReviewStepPrompt,
  REVIEW_FIX_ROUNDS_MAX,
  REVIEW_STEP_TIMEOUT_MS,
  type ReviewFinding,
} from '@nautelle/shared';
import {
  CARD_REVIEW_BODY_MAX_BYTES,
  CARD_REVIEW_COMMENT_MAX_BYTES,
  CARD_REVIEW_COMMENTS_MAX,
  type CardReviewComment,
  type LocalMethodArgs,
  ORCHESTRATOR_DEFAULTS,
  type OrchestratorPermissionMode,
} from '@nautelle/shared/protocol';
import {
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import {
  type BoardCardReviewRun,
  Prisma,
  type ProjectReviewStep,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { SYSTEM_ACTOR } from '../audit/audit.types';
import { BudgetExceededError } from '../budgets/budget-error';
import { BudgetGate } from '../budgets/budget-gate';
import { PrismaService } from '../database/prisma.service';
import { RuntimeProfileResolver } from '../readiness';
import { BoardCommands, boardOutput } from './board-commands';
import { BoardFailure, boardError } from './board-error';
import type { CardWithRounds } from './board-mapper';
import { BoardRoundsService } from './board-rounds.service';
import type { BoardProject } from './board-work';
import { BoardWork } from './board-work';

/** #884: the reason `needsPerson` is audited with when the fix budget is spent. */
export const REVIEW_STILL_BLOCKING =
  'review_still_blocking' satisfies CardNeedsPersonReason;

/** #884: a review step could not start, timed out or never reported. */
export const REVIEW_FAILED = 'review_failed' satisfies CardNeedsPersonReason;

/**
 * #884: what the review gate answers the shipping flow for a green head.
 * - `pass` — review is off, or every enabled step passed: the card may go to
 *   Finished;
 * - `wait` — a step is running, a fix round started, or a start was refused
 *   for now: the next poll asks again;
 * - `needs_person` — the card was marked `needsPerson`: it goes to Finished,
 *   where auto-merge refuses it.
 */
export type ReviewGate = 'pass' | 'wait' | 'needs_person';

/** The longest `error` a failed run stores. */
const RUN_ERROR_MAX = 500;

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** Cuts `text` to at most `max` UTF-8 bytes, on a character boundary. */
const clipBytes = (text: string, max: number): string => {
  if (utf8Bytes(text) <= max) return text;
  let cut = text.slice(0, max);
  while (utf8Bytes(`${cut}…`) > max) cut = cut.slice(0, -1);
  return `${cut}…`;
};

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

/** The stored findings of a run, as the shared `ReviewFinding[]`. */
export const findingsOf = (value: Prisma.JsonValue): ReviewFinding[] =>
  Array.isArray(value) ? (value as unknown as ReviewFinding[]) : [];

type Report = LocalMethodArgs<'card.reviewReport'>;

const findingPlace = (finding: Pick<ReviewFinding, 'file' | 'line'>) =>
  finding.file
    ? ` (\`${finding.file}${finding.line ? `:${finding.line}` : ''}\`)`
    : '';

const severityLabel = (finding: ReviewFinding): string =>
  finding.severity === 'blocking' ? '**Blocking**' : 'Nit';

/**
 * #884 (ADR-0084 §6): a step's findings as one GitHub pull request review —
 * each finding with a file and a line inline, every other one in the body
 * after the summary. Inline comments over `CARD_REVIEW_COMMENTS_MAX` are
 * folded into the body too.
 */
export const reviewPublication = (
  label: string,
  stepName: string,
  findings: readonly ReviewFinding[],
  summary: string | null,
): { body: string; comments: CardReviewComment[] } => {
  const comments: CardReviewComment[] = [];
  const listed: ReviewFinding[] = [];
  for (const finding of findings) {
    if (
      finding.file !== undefined &&
      finding.line !== undefined &&
      comments.length < CARD_REVIEW_COMMENTS_MAX
    ) {
      comments.push({
        path: finding.file,
        line: finding.line,
        body: clipBytes(
          `${severityLabel(finding)}: ${finding.title}\n\n${finding.body}`.trim(),
          CARD_REVIEW_COMMENT_MAX_BYTES,
        ),
      });
    } else {
      listed.push(finding);
    }
  }
  const blocking = findings.filter((f) => f.severity === 'blocking').length;
  const nits = findings.length - blocking;
  const body = [
    `### ${stepName} — ${label}`,
    '',
    findings.length === 0
      ? 'No findings.'
      : `${blocking} blocking, ${nits} ${nits === 1 ? 'nit' : 'nits'}.`,
    ...(summary ? ['', summary] : []),
    ...listed.flatMap((f) => [
      '',
      `- ${severityLabel(f)}: ${f.title}${findingPlace(f)}`,
      ...(f.body ? ['', f.body] : []),
    ]),
    '',
    '_Posted by Nautelle review._',
  ].join('\n');
  return { body: clipBytes(body, CARD_REVIEW_BODY_MAX_BYTES), comments };
};

/**
 * The review gate (issue #884, ADR-0084 §3–5): with review on for the project,
 * a card whose PR is green runs every enabled review step, in `position`
 * order, on the PR's head before it goes to Finished. Each step is its own
 * runner session (`card.review`), started as the person Nautelle's fix
 * rounds run as and charged to them; it reports its findings through
 * `report_review` (`card.reviewReport`). Blocking findings start one
 * `review_fix` round with all of them — at most `REVIEW_FIX_ROUNDS_MAX` per
 * PR, then the card needs a person. A `nit` never holds a card back.
 */
@Injectable()
export class BoardReview {
  private readonly logger = new Logger(BoardReview.name);
  private reported: ((cardId: string) => void) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly work: BoardWork,
    private readonly rounds: BoardRoundsService,
    private readonly commands: BoardCommands,
    private readonly audit: AuditService,
    private readonly profiles: RuntimeProfileResolver,
    @Optional() private readonly budgets?: BudgetGate,
  ) {}

  /**
   * `BoardShipping` registers what runs once a step reported — the gate is
   * asked again at once instead of at the next poll. It cannot be injected
   * here: shipping depends on this service.
   */
  onReported(listener: (cardId: string) => void): void {
    this.reported = listener;
  }

  /** The project's enabled steps, in order; none when review is off. */
  async enabledSteps(projectId: string): Promise<ProjectReviewStep[]> {
    const settings = await this.prisma.boardSettings.findUnique({
      where: { projectId },
      select: { reviewEnabled: true },
    });
    if (!settings?.reviewEnabled) return [];
    return this.prisma.projectReviewStep.findMany({
      where: { projectId, enabled: true },
      orderBy: { position: 'asc' },
    });
  }

  /**
   * #884: the gate for the card's green head `headSha`. Starts the next step
   * that has not run on `(headSha, pass)`, waits for the one running, and,
   * once every step ran, passes the card, starts a `review_fix` round, or —
   * a step failed, or the fix budget is spent — marks it `needsPerson`.
   */
  async gate(
    project: BoardProject,
    card: CardWithRounds,
    headSha: string,
  ): Promise<ReviewGate> {
    if (card.prNumber === null) return 'pass';
    const steps = await this.enabledSteps(project.id);
    if (steps.length === 0) return 'pass';
    const pass = card.reviewFixAttempts;
    await this.supersede(project, card, headSha, pass);
    const runs = await this.prisma.boardCardReviewRun.findMany({
      where: { cardId: card.id, headSha, pass },
    });
    const byStep = new Map(runs.map((r) => [r.stepId, r]));
    const done: BoardCardReviewRun[] = [];
    for (const step of steps) {
      const run = byStep.get(step.id);
      if (!run) return this.startStep(project, card, step, headSha, pass);
      if (run.state === 'running') {
        if (Date.now() - run.startedAt.getTime() < REVIEW_STEP_TIMEOUT_MS) {
          return 'wait';
        }
        await this.failRun(run.id, 'the step did not report in time');
        await this.stopSession(project, card);
        await this.needsPerson(project, card, REVIEW_FAILED, {
          headSha,
          step: step.name,
          error: 'timeout',
        });
        return 'needs_person';
      }
      if (run.state === 'failed') {
        await this.stopSession(project, card);
        await this.needsPerson(project, card, REVIEW_FAILED, {
          headSha,
          step: step.name,
          ...(run.error ? { error: run.error } : {}),
        });
        return 'needs_person';
      }
      done.push(run);
    }
    await this.stopSession(project, card);
    const blocked = done.filter((r) => r.state === 'blocked');
    if (blocked.length === 0) return 'pass';
    if (card.reviewFixAttempts >= REVIEW_FIX_ROUNDS_MAX) {
      await this.needsPerson(project, card, REVIEW_STILL_BLOCKING, {
        headSha,
        attempts: card.reviewFixAttempts,
        blocking: blocked.reduce((n, r) => n + r.blockingCount, 0),
      });
      return 'needs_person';
    }
    const findings: CardReviewFixFinding[] = blocked.flatMap((run) =>
      findingsOf(run.findings)
        .filter((f) => f.severity === 'blocking')
        .map((f) => ({
          stepName: run.stepName,
          ...(f.file !== undefined ? { file: f.file } : {}),
          ...(f.line !== undefined ? { line: f.line } : {}),
          title: f.title,
          body: f.body,
        })),
    );
    try {
      await this.rounds.reviewFix(project.id, card.number, {
        headSha,
        findings,
      });
    } catch (error) {
      // No room, a budget stop, the runner away: the next poll tries again.
      if (!this.retryable(error)) throw error;
      this.logger.warn(
        `review_fix round of ${cardLabel(card.number)} not started: ${error.message}`,
      );
    }
    return 'wait';
  }

  /**
   * #884: `report_review` of the review session `sessionId` in the asking
   * runner's project — `null` when it is no running review step. Stores the
   * findings, publishes them when the project mirrors findings on GitHub
   * (a failure is logged and never holds the card back), and asks the gate
   * again.
   */
  async report(
    project: { id: string; runnerId: string },
    sessionId: string,
    report: Report,
  ): Promise<{ number: number; blocking: number; nits: number } | null> {
    const run = await this.prisma.boardCardReviewRun.findFirst({
      where: {
        sessionId,
        state: 'running',
        card: {
          projectId: project.id,
          project: { runnerId: project.runnerId },
        },
      },
      include: { card: { select: { number: true, projectId: true } } },
    });
    if (!run) return null;
    const findings: ReviewFinding[] = report.findings.map((f) => ({
      stepId: run.stepId ?? '',
      severity: f.severity,
      ...(f.file !== undefined ? { file: f.file } : {}),
      ...(f.line !== undefined ? { line: f.line } : {}),
      title: f.title,
      body: f.body,
    }));
    const blocking = findings.filter((f) => f.severity === 'blocking').length;
    const nits = findings.length - blocking;
    const now = new Date();
    const { count } = await this.prisma.boardCardReviewRun.updateMany({
      where: { id: run.id, state: 'running' },
      data: {
        state: blocking > 0 ? 'blocked' : 'passed',
        findings: findings as unknown as Prisma.InputJsonValue,
        blockingCount: blocking,
        nitCount: nits,
        summary: report.summary ?? null,
        finishedAt: now,
      },
    });
    if (count === 0) return null;
    await this.closeRun(run.runId, 'succeeded', now);
    await this.audit.record({
      actor: SYSTEM_ACTOR,
      action: 'card.review_reported',
      target: { type: 'board_card', id: run.cardId },
      projectId: project.id,
      after: {
        number: run.card.number,
        step: run.stepName,
        pr: run.prNumber,
        headSha: run.headSha,
        pass: run.pass,
        blocking,
        nits,
      },
      result: 'ok',
    });
    this.work.publish(project.id, run.cardId);
    await this.publish(run, findings, report.summary ?? null);
    this.reported?.(run.cardId);
    return { number: run.card.number, blocking, nits };
  }

  /**
   * #884 (ADR-0084 §6): the findings as a GitHub PR review through the
   * runner (`card.reviewPublish`) when the project asks for it. Never
   * throws: a failure is logged and audited, and the gate goes on.
   */
  private async publish(
    run: BoardCardReviewRun & { card: { number: number; projectId: string } },
    findings: readonly ReviewFinding[],
    summary: string | null,
  ): Promise<void> {
    const settings = await this.prisma.boardSettings.findUnique({
      where: { projectId: run.card.projectId },
      select: { publishReviewComments: true },
    });
    if (!settings?.publishReviewComments) return;
    const label = cardLabel(run.card.number);
    try {
      const project = await this.work.project(run.card.projectId);
      const { body, comments } = reviewPublication(
        label,
        run.stepName,
        findings,
        summary,
      );
      const output = boardOutput(
        'card.reviewPublish',
        await this.commands.publishReview(
          project.runnerId,
          {
            cardId: run.cardId,
            projectId: project.id,
            root: project.rootPath,
            prNumber: run.prNumber,
            headSha: run.headSha,
            body,
            comments,
          },
          {
            role: 'operator',
            ctx: { actor: SYSTEM_ACTOR },
            auditArgs: {
              cardId: run.cardId,
              prNumber: run.prNumber,
              headSha: run.headSha,
              comments: comments.length,
            },
          },
        ),
      );
      if (!output.published) {
        this.logger.warn(`review of ${label} not published: ${output.message}`);
        return;
      }
      await this.prisma.boardCardReviewRun.update({
        where: { id: run.id },
        data: { publishedAt: new Date() },
      });
    } catch (error) {
      if (!(error instanceof BoardFailure)) {
        this.logger.error(
          `review of ${label} not published`,
          error instanceof Error ? error.stack : String(error),
        );
        return;
      }
      this.logger.warn(`review of ${label} not published: ${error.message}`);
    }
  }

  /**
   * Starts `step` on the card's head. The run row is created first, so two
   * polls never start the same step twice; a start the runner refuses marks
   * it `failed` and the card `needsPerson`; one refused for now — no runner,
   * a budget stop, the person's role — starts nothing, and the next poll
   * tries again.
   */
  private async startStep(
    project: BoardProject,
    card: CardWithRounds,
    step: ProjectReviewStep,
    headSha: string,
    pass: number,
  ): Promise<ReviewGate> {
    const label = cardLabel(card.number);
    const prNumber = card.prNumber;
    if (prNumber === null) return 'pass';
    const support = this.commands.reviewSupport(project.runnerId);
    if (support === 'offline') return 'wait';
    if (support === 'unsupported') {
      await this.needsPerson(project, card, REVIEW_FAILED, {
        headSha,
        step: step.name,
        error: 'the runner does not run review steps',
      });
      return 'needs_person';
    }
    let launch: Awaited<ReturnType<BoardReview['launchOf']>>;
    try {
      launch = await this.launchOf(project, card);
    } catch (error) {
      if (!this.retryable(error)) throw error;
      this.logger.warn(
        `review step "${step.name}" of ${label} not started: ${error.message}`,
      );
      return 'wait';
    }
    const prompt = cardReviewStepPrompt({
      label,
      title: card.title,
      prNumber,
      headSha,
      base: card.prBase ?? project.base,
      step:
        step.type === 'skill'
          ? { type: 'skill', name: step.name, skillName: step.skillName ?? '' }
          : {
              type: 'peer_review',
              name: step.name,
              instructions: step.instructions ?? '',
            },
    });
    const sessionId = randomUUID();
    const now = new Date();
    let created: { id: string; runId: string };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const run = await tx.run.create({
          data: {
            kind: 'card_review',
            projectId: project.id,
            issue: card.issueNumber,
            title: `${label} review: ${step.name}`.slice(0, 200),
            runtime: launch.profile.runtime,
            model: launch.model,
            profileKey: launch.profile.key,
            args: {
              card: card.number,
              step: step.name,
              stepType: step.type,
              pr: prNumber,
              headSha,
              pass,
              permissionMode: launch.permissionMode,
            },
            status: 'running',
            triggeredByType: 'user',
            triggeredById: launch.actor.userId,
            startedAt: now,
            updatedAt: now,
          },
          select: { id: true },
        });
        return tx.boardCardReviewRun.create({
          data: {
            cardId: card.id,
            roundId: card.rounds[0]?.id ?? null,
            stepId: step.id,
            stepName: step.name,
            stepType: step.type,
            position: step.position,
            prNumber,
            headSha,
            pass,
            runId: run.id,
            sessionId,
            startedAt: now,
          },
          select: { id: true, runId: true },
        });
      });
    } catch (error) {
      // Another poll started it first.
      if (isUniqueViolation(error)) return 'wait';
      throw error;
    }
    try {
      const output = boardOutput(
        'card.review',
        await this.commands.review(
          project.runnerId,
          {
            cardId: card.id,
            projectId: project.id,
            runId: created.runId,
            root: project.rootPath,
            shortId: card.shortId,
            branch: card.branch ?? '',
            headSha,
            session: sessionId,
            prompt,
            profileKey: launch.profile.key,
            model: launch.model,
            permissionMode: launch.permissionMode,
          },
          {
            role: launch.actor.role,
            ctx: launch.actor.ctx,
            // The step's instructions are a person's text: not verbatim in audit.
            auditArgs: {
              cardId: card.id,
              runId: created.runId,
              shortId: card.shortId,
              headSha,
              session: sessionId,
              prompt: `[${prompt.length} chars]`,
              model: launch.model,
              permissionMode: launch.permissionMode,
            },
          },
        ),
      );
      await this.audit.record({
        ...launch.actor.ctx,
        action: 'card.review_started',
        target: { type: 'board_card', id: card.id },
        projectId: project.id,
        after: {
          number: card.number,
          step: step.name,
          stepType: step.type,
          pr: prNumber,
          headSha,
          pass,
          runId: created.runId,
          tmuxSession: output.tmuxSession,
          model: launch.model,
        },
        result: 'ok',
      });
    } catch (error) {
      if (!(error instanceof BoardFailure)) throw error;
      // No answer: the runner may have started it; a report or the timeout
      // settles it.
      if (error.statusCode === 504) return 'wait';
      if (error.statusCode === 503) {
        // The runner went away between the check and the send: the run
        // cascades with its `card_review` run.
        await this.prisma.run.delete({ where: { id: created.runId } });
        return 'wait';
      }
      await this.failRun(created.id, error.message);
      this.logger.warn(
        `review step "${step.name}" of ${label} refused: ${error.message}`,
      );
      await this.needsPerson(project, card, REVIEW_FAILED, {
        headSha,
        step: step.name,
        error: clip(error.message, RUN_ERROR_MAX),
      });
      return 'needs_person';
    }
    this.work.publish(project.id, card.id);
    return 'wait';
  }

  /**
   * Who a review step runs as, and how: the person Nautelle's fix rounds run
   * as (C-181), in their round's mode; the card's model and profile. A
   * hard-stop budget of theirs or the project's refuses it, as it refuses a
   * `ci_fix` round.
   */
  private async launchOf(project: BoardProject, card: CardWithRounds) {
    const settings = await this.prisma.projectOrchestratorSettings.findUnique({
      where: { projectId: project.id },
      select: { model: true, permissionMode: true },
    });
    const fix = await this.rounds.fixLaunchOf(card);
    const permissionMode: OrchestratorPermissionMode =
      fix.permissionMode ??
      settings?.permissionMode ??
      ORCHESTRATOR_DEFAULTS.permissionMode;
    if (permissionMode === 'bypassPermissions' && fix.actor.role !== 'admin') {
      throw new ForbiddenException(
        '`bypassPermissions` needs the admin role on the project',
      );
    }
    const profile = await this.profiles.require(
      project,
      { key: card.profileKey },
      (details, message) =>
        boardError(422, BOARD_ERROR.noProfile, message, details),
    );
    await this.budgets?.assertAllowed({
      projectId: project.id,
      userId: fix.actor.userId,
    });
    return {
      actor: fix.actor,
      permissionMode,
      profile,
      model: card.model ?? settings?.model ?? ORCHESTRATOR_DEFAULTS.model,
    };
  }

  /**
   * A run still `running` on an earlier head or pass — the PR moved on under
   * it — fails as superseded; its session is replaced by the next step's.
   */
  private async supersede(
    project: BoardProject,
    card: CardWithRounds,
    headSha: string,
    pass: number,
  ): Promise<void> {
    const stale = await this.prisma.boardCardReviewRun.findMany({
      where: {
        cardId: card.id,
        state: 'running',
        NOT: { headSha, pass },
      },
      select: { id: true },
    });
    if (stale.length === 0) return;
    for (const run of stale) {
      await this.failRun(run.id, 'superseded by a newer head');
    }
    await this.stopSession(project, card);
  }

  private async failRun(id: string, error: string): Promise<void> {
    const now = new Date();
    const run = await this.prisma.boardCardReviewRun.update({
      where: { id },
      data: {
        state: 'failed',
        error: clip(error, RUN_ERROR_MAX),
        finishedAt: now,
      },
      select: { runId: true },
    });
    await this.closeRun(run.runId, 'failed', now, error);
  }

  private async closeRun(
    runId: string,
    status: 'succeeded' | 'failed',
    at: Date,
    outcome?: string,
  ): Promise<void> {
    await this.prisma.run.updateMany({
      where: { id: runId, status: 'running' },
      data: {
        status,
        endedAt: at,
        updatedAt: at,
        ...(outcome ? { outcome: clip(outcome, RUN_ERROR_MAX) } : {}),
      },
    });
  }

  /** Best effort: the session and the review worktree go; a refusal is logged. */
  private async stopSession(
    project: BoardProject,
    card: CardWithRounds,
  ): Promise<void> {
    if (this.commands.reviewSupport(project.runnerId) !== 'connected') return;
    try {
      boardOutput(
        'card.reviewStop',
        await this.commands.stopReview(
          project.runnerId,
          {
            cardId: card.id,
            projectId: project.id,
            root: project.rootPath,
            shortId: card.shortId,
          },
          { role: 'operator', ctx: { actor: SYSTEM_ACTOR } },
        ),
      );
    } catch (error) {
      if (!(error instanceof BoardFailure)) throw error;
      this.logger.warn(
        `review session of ${cardLabel(card.number)} not stopped: ${error.message}`,
      );
    }
  }

  /** `needsPerson` with `reason`, audited like CI-fix exhaustion. */
  private async needsPerson(
    project: BoardProject,
    card: CardWithRounds,
    reason: CardNeedsPersonReason,
    details: Record<string, string | number>,
  ): Promise<void> {
    await this.prisma.boardCard.update({
      where: { id: card.id },
      data: { needsPerson: true, needsPersonReason: reason },
    });
    await this.audit.record({
      actor: SYSTEM_ACTOR,
      action: 'card.auto_run_failed',
      target: { type: 'board_card', id: card.id },
      projectId: project.id,
      after: { number: card.number, reason, pr: card.prNumber, ...details },
      result: 'ok',
    });
    this.work.publish(project.id, card.id);
  }

  /** What leaves the gate waiting for the next poll instead of throwing. */
  private retryable(
    error: unknown,
  ): error is BoardFailure | ForbiddenException | BudgetExceededError {
    return (
      error instanceof BoardFailure ||
      error instanceof ForbiddenException ||
      error instanceof BudgetExceededError
    );
  }
}
