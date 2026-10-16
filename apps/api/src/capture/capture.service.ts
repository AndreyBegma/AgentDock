import { randomUUID } from 'node:crypto';
import {
  CAPTURE_COMPLETED_DEDUPE_DAYS,
  CAPTURE_DISMISSAL_DEDUPE_DAYS,
  CAPTURE_INBOX_MAX,
  CAPTURE_MAX_PER_PROJECT_PER_DAY,
  CAPTURE_MAX_RUNNING_PER_PROJECT,
  CAPTURE_MODEL_DEFAULT,
  CAPTURE_OFFLINE_BACKOFF_MAX_MS,
  CAPTURE_OPEN_TITLES_MAX,
  CAPTURE_SESSION_MIN_INTERVAL_MS,
  CAPTURE_TIMEOUT_SEC,
  CARDS_SUGGESTED_EVENT,
  type CaptureSkipReason,
  type CardsSuggestedEventData,
  captureViolationError,
  isCaptureModel,
  parseCaptureOutput,
  selectCaptureInput,
} from '@agentdock/shared';
import type {
  CardsExtractArgs,
  CardsExtractFinishedData,
} from '@agentdock/shared/protocol';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { BOARD_SYSTEM_ACTOR, BoardWork } from '../board';
import { BudgetGate } from '../budgets/budget-gate';
import { PrismaService } from '../database/prisma.service';
import { RuntimeProfileResolver } from '../readiness';
import { TokenSaverService } from '../token-saver/token-saver.service';
import {
  evidenceExcerpts,
  knownFingerprints,
  planCaptureApply,
} from './capture-apply';
import { CaptureCommands } from './capture-commands';
import { CAPTURE_ROWS_MAX, prepareCaptureInput } from './capture-input';
import { type CaptureJobData, CaptureQueue } from './capture-queue';

type Tx = Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A running extraction with no result this long after it started is given up. */
export const CAPTURE_STALE_MS = (CAPTURE_TIMEOUT_SEC + 10 * 60) * 1000;
/** Another extraction of the project runs: look again this much later (D7). */
const BUSY_RETRY_MS = 60_000;
/** Runner offline: the first wait; it doubles up to `OFFLINE_STEP_MAX_MS` (D7). */
const OFFLINE_STEP_MIN_MS = 60_000;
const OFFLINE_STEP_MAX_MS = 30 * 60_000;
/** `card_captures.error` and `runs.outcome` are short and never content. */
const ERROR_MAX = 500;

/** What one job did; the worker turns `deferred` into a delayed job. */
export type ExtractOutcome =
  | { kind: 'none'; why: string }
  | { kind: 'skipped'; captureId: string; reason: CaptureSkipReason }
  | {
      kind: 'deferred';
      untilMs: number;
      why: 'busy' | 'session_interval' | 'runner_offline';
      offlineSince?: number;
    }
  | { kind: 'started'; captureId: string; runId: string }
  | { kind: 'failed'; captureId: string; error: string };

interface CaptureSession {
  id: string;
  runnerId: string;
  projectId: string;
}

interface CaptureProject {
  id: string;
  runnerId: string;
  rootPath: string;
  repo: string;
  shipSessionContent: boolean;
  defaultProfileId: string | null;
}

const PROJECT_SELECT = {
  id: true,
  runnerId: true,
  rootPath: true,
  repo: true,
  shipSessionContent: true,
  defaultProfileId: true,
} as const;

/**
 * Card capture (issue #244, ADR-0026): reads a manual session's new prompts
 * and final responses, asks a small model on the project's runner for
 * candidate cards (`cards.extract`), and puts what survives dedupe in the
 * Board's Inbox. Every extraction is a `card_captures` row — a skip too, so
 * the settings page can say why nothing came — and every one that ran is a
 * `runs` row of kind `card_capture`.
 *
 * The session's watermark is its newest capture's `contentToId`: an
 * extraction that ran moves it past what it sent, so content is never sent
 * twice; a skip and a failure before sending keep it.
 */
@Injectable()
export class CaptureService {
  private readonly logger = new Logger(CaptureService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly work: BoardWork,
    private readonly commands: CaptureCommands,
    private readonly queue: CaptureQueue,
    private readonly audit: AuditService,
    private readonly profiles: RuntimeProfileResolver,
    private readonly tokenSaver: TokenSaverService,
    @Optional() private readonly budgets?: BudgetGate,
  ) {}

  /**
   * D1: the `sessions.id` whose hook may schedule an extraction — a Claude
   * session of `runnerId` with `origin = manual`, in a project that ships
   * content and has capture on — else `null`.
   */
  async eligibleSession(
    runnerId: string,
    externalId: string,
  ): Promise<string | null> {
    const session = await this.prisma.agentSession.findFirst({
      where: { runnerId, runtime: 'claude', externalId, origin: 'manual' },
      select: {
        id: true,
        project: {
          select: {
            shipSessionContent: true,
            boardSettings: { select: { captureEnabled: true } },
          },
        },
      },
    });
    const project = session?.project;
    return session &&
      project?.shipSessionContent &&
      project.boardSettings?.captureEnabled
      ? session.id
      : null;
  }

  /** One `card-capture` job (D3, D4, D7). */
  async extract(
    data: CaptureJobData,
    now: Date = new Date(),
  ): Promise<ExtractOutcome> {
    const found = await this.prisma.agentSession.findUnique({
      where: { id: data.sessionId },
      select: {
        id: true,
        runnerId: true,
        runtime: true,
        origin: true,
        projectId: true,
        project: { select: PROJECT_SELECT },
      },
    });
    if (
      !found ||
      found.runtime !== 'claude' ||
      found.origin !== 'manual' ||
      found.projectId === null ||
      !found.project ||
      // Content comes from the project's runner; capture runs there only.
      found.project.runnerId !== found.runnerId
    ) {
      return { kind: 'none', why: 'not a manual session of a project' };
    }
    const session: CaptureSession = {
      id: found.id,
      runnerId: found.runnerId,
      projectId: found.projectId,
    };
    const project: CaptureProject = found.project;

    const retry = data.retryOf
      ? await this.prisma.cardCapture.findFirst({
          where: { id: data.retryOf, sessionId: session.id, status: 'failed' },
          select: { id: true, contentFromId: true, contentToId: true },
        })
      : null;
    if (data.retryOf && !retry) {
      return { kind: 'none', why: 'nothing to retry' };
    }
    const watermark = await this.watermark(session.id);
    const skip = (reason: CaptureSkipReason, inputChars = 0) =>
      this.skip(session, watermark, reason, inputChars, now);

    const settings = await this.prisma.boardSettings.findUnique({
      where: { projectId: project.id },
      select: { captureEnabled: true, captureModel: true },
    });
    if (!project.shipSessionContent || !settings?.captureEnabled) {
      return skip('capture_off');
    }
    // #282 D5: the session's work is on the Board already, as its tracked card.
    const tracked = await this.prisma.boardCard.count({
      where: { trackedSessionId: session.id },
    });
    if (tracked > 0) return skip('tracked');

    await this.giveUpStale(project.id, now);
    if (await this.busy(project.id)) {
      return {
        kind: 'deferred',
        untilMs: now.getTime() + BUSY_RETRY_MS,
        why: 'busy',
      };
    }
    if (!retry) {
      const last = await this.prisma.cardCapture.findFirst({
        where: { sessionId: session.id, runId: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const next = last
        ? last.createdAt.getTime() + CAPTURE_SESSION_MIN_INTERVAL_MS
        : 0;
      if (next > now.getTime()) {
        return { kind: 'deferred', untilMs: next, why: 'session_interval' };
      }
    }

    const [inbox, today] = await Promise.all([
      this.prisma.boardCard.count({
        where: { projectId: project.id, column: 'inbox' },
      }),
      this.prisma.cardCapture.count({
        where: {
          projectId: project.id,
          runId: { not: null },
          createdAt: { gt: new Date(now.getTime() - DAY_MS) },
        },
      }),
    ]);
    if (inbox >= CAPTURE_INBOX_MAX) return skip('inbox_full');
    if (today >= CAPTURE_MAX_PER_PROJECT_PER_DAY) return skip('rate_limited');
    // Spec 28 D3: capture has no person behind it — project budgets only.
    const budget = await this.budgets?.check({
      projectId: project.id,
      userId: null,
    });
    if (budget && !budget.allowed) return skip('budget_exceeded');

    const [rows, open] = await Promise.all([
      this.prisma.sessionContent.findMany({
        where: {
          sessionId: session.id,
          kind: { in: ['prompt', 'response'] },
          id: retry
            ? { gte: retry.contentFromId, lte: retry.contentToId }
            : watermark !== null
              ? { gt: watermark }
              : undefined,
        },
        orderBy: { id: 'desc' },
        take: CAPTURE_ROWS_MAX,
        select: { id: true, kind: true, text: true },
      }),
      this.prisma.boardCard.findMany({
        where: { projectId: project.id, column: { not: 'completed' } },
        orderBy: { createdAt: 'desc' },
        take: CAPTURE_OPEN_TITLES_MAX,
        select: { title: true },
      }),
    ]);
    const input = prepareCaptureInput(
      rows,
      retry ? null : watermark,
      open.map((c) => c.title),
    );
    if (!input.ok) return skip('too_little', input.inputChars);

    if (!this.commands.ready(project.runnerId)) {
      const since = data.offlineSince ?? now.getTime();
      const waited = now.getTime() - since;
      if (waited >= CAPTURE_OFFLINE_BACKOFF_MAX_MS) {
        return skip('runner_offline', input.selection.inputChars);
      }
      const step = Math.min(
        OFFLINE_STEP_MAX_MS,
        Math.max(OFFLINE_STEP_MIN_MS, waited),
        since + CAPTURE_OFFLINE_BACKOFF_MAX_MS - now.getTime(),
      );
      return {
        kind: 'deferred',
        untilMs: now.getTime() + step,
        why: 'runner_offline',
        offlineSince: since,
      };
    }

    const range = {
      contentFromId: BigInt(input.selection.contentFromId),
      contentToId: BigInt(input.selection.contentToId),
      inputChars: input.selection.inputChars,
    };
    // #272 D1: the orchestrator's profile, else the project default; none
    // usable is a skip the UI can name (D8), not a failure.
    const pick = await this.profiles.resolve(project);
    if (!pick.ok) return skip('no_profile', range.inputChars);
    const { profile } = pick;
    const model =
      settings.captureModel && isCaptureModel(settings.captureModel)
        ? settings.captureModel
        : CAPTURE_MODEL_DEFAULT;
    const extractSessionId = randomUUID();
    // #445 D11: only a runner that advertises the token saver gets the field.
    const saver = await this.tokenSaver.launch(project.id);

    const started = await this.prisma.$transaction(async (tx) => {
      await this.lockProject(tx, project.id);
      if (await this.busy(project.id, tx)) return null;
      const run = await tx.run.create({
        data: {
          kind: 'card_capture',
          projectId: project.id,
          title: 'Card capture',
          runtime: 'claude',
          model,
          profileKey: profile.key,
          args: {
            sessionId: session.id,
            ...(retry ? { retryOf: retry.id } : {}),
          },
          tokenSaver: saver.on,
          status: 'running',
          triggeredByType: 'capture',
          triggeredById: null,
          startedAt: now,
          updatedAt: now,
        },
        select: { id: true },
      });
      const capture = await tx.cardCapture.create({
        data: {
          projectId: project.id,
          sessionId: session.id,
          runId: run.id,
          extractSessionId,
          ...range,
          status: 'running',
        },
        select: { id: true },
      });
      return { runId: run.id, captureId: capture.id };
    });
    if (!started) {
      return {
        kind: 'deferred',
        untilMs: now.getTime() + BUSY_RETRY_MS,
        why: 'busy',
      };
    }
    this.work.publishRun(project.id, started.runId, 'running');

    const args: CardsExtractArgs = {
      runId: started.runId,
      projectId: project.id,
      sessionId: extractSessionId,
      prompt: input.prompt,
      profileKey: profile.key,
      model,
      timeoutSec: CAPTURE_TIMEOUT_SEC,
      ...saver.args,
    };
    let sent: Awaited<ReturnType<CaptureCommands['extract']>>;
    try {
      sent = await this.commands.extract(project.runnerId, args);
    } catch (error) {
      sent = { status: 'error', message: (error as Error).message };
    }
    if (sent.status === 'error') {
      const message = `runner: ${sent.message}`.slice(0, ERROR_MAX);
      await this.fail(started.captureId, message, !retry);
      return { kind: 'failed', captureId: started.captureId, error: message };
    }
    // `unknown`: the runner may have started it; its event, or the stale
    // sweep, settles it.
    return { kind: 'started', ...started };
  }

  /**
   * `cards_extract.finished` from `runnerId` (D5, D6). Applied once: only a
   * `running` capture of that runner's project is touched.
   */
  async finished(
    runnerId: string,
    data: CardsExtractFinishedData,
  ): Promise<void> {
    const capture = await this.prisma.cardCapture.findFirst({
      where: {
        runId: data.runId,
        projectId: data.projectId,
        project: { runnerId },
      },
      select: {
        id: true,
        status: true,
        projectId: true,
        sessionId: true,
        contentFromId: true,
        contentToId: true,
        run: { select: { args: true } },
      },
    });
    if (!capture || capture.status !== 'running') return;
    const isRetry = this.isRetry(capture.run?.args ?? null);
    if (!data.ok) {
      await this.fail(
        capture.id,
        `runner: ${data.error ?? 'failed'}`.slice(0, ERROR_MAX),
        !isRetry,
      );
      return;
    }
    const result = data.result ?? '';
    if (data.resultTruncated) {
      await this.fail(
        capture.id,
        'contract_violation: truncated — the result was cut at its limit',
        false,
        result,
      );
      return;
    }

    // The ids the prompt held: the same selection over the same range.
    const rows = await this.prisma.sessionContent.findMany({
      where: {
        sessionId: capture.sessionId,
        kind: { in: ['prompt', 'response'] },
        id: { gte: capture.contentFromId, lte: capture.contentToId },
      },
      orderBy: { id: 'desc' },
      take: CAPTURE_ROWS_MAX,
      select: { id: true, kind: true, text: true },
    });
    const selection = selectCaptureInput(rows, null);
    const inputIds = selection.ok ? selection.items.map((i) => i.id) : [];
    const parsed = parseCaptureOutput(result, inputIds);
    if (!parsed.ok) {
      await this.fail(capture.id, captureViolationError(parsed), false, result);
      return;
    }
    await this.apply(capture, parsed.cards, result, rows);
  }

  /** D6: dedupe, then the survivors become Inbox cards, all in one transaction. */
  private async apply(
    capture: { id: string; projectId: string; sessionId: string },
    suggestions: Parameters<typeof planCaptureApply>[0],
    result: string,
    rows: { id: bigint; kind: string; text: string }[],
  ): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: capture.projectId },
      select: PROJECT_SELECT,
    });
    if (!project) return;
    const now = new Date();
    const sources = new Map(
      rows.map((row) => [
        row.id.toString(),
        { kind: row.kind, text: row.text },
      ]),
    );

    const applied = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.cardCapture.updateMany({
        where: { id: capture.id, status: 'running' },
        data: { status: 'succeeded', finishedAt: now, resultText: result },
      });
      if (claimed.count === 0) return null;
      const [cards, dismissals, inbox, settings] = await Promise.all([
        tx.boardCard.findMany({
          where: {
            projectId: project.id,
            OR: [
              { column: { not: 'completed' } },
              {
                completedAt: {
                  gte: new Date(
                    now.getTime() - CAPTURE_COMPLETED_DEDUPE_DAYS * DAY_MS,
                  ),
                },
              },
            ],
          },
          select: {
            title: true,
            fingerprint: true,
            column: true,
            completedAt: true,
          },
        }),
        tx.cardDismissal.findMany({
          where: {
            projectId: project.id,
            createdAt: {
              gte: new Date(
                now.getTime() - CAPTURE_DISMISSAL_DEDUPE_DAYS * DAY_MS,
              ),
            },
          },
          select: { fingerprint: true, createdAt: true },
        }),
        tx.boardCard.count({
          where: { projectId: project.id, column: 'inbox' },
        }),
        tx.boardSettings.findUnique({
          where: { projectId: project.id },
          select: { issueOnRun: true, specOnRun: true },
        }),
      ]);
      const plan = planCaptureApply(
        suggestions,
        knownFingerprints(cards, dismissals, now),
        CAPTURE_INBOX_MAX - inbox,
      );
      const created: { id: string; number: number }[] = [];
      // Each lands on top: the last first, so the model's order reads down.
      for (const card of [...plan.kept].reverse()) {
        const next = await this.work.nextCard(tx, project.id);
        const position = await this.work.place(
          tx,
          { id: '', projectId: project.id },
          'inbox',
          0,
        );
        const evidence = evidenceExcerpts(card.evidence, sources);
        const row = await tx.boardCard.create({
          data: {
            projectId: project.id,
            ...next,
            title: card.title,
            body: card.body,
            kind: card.kind,
            column: 'inbox',
            position,
            source: 'captured',
            issueOnRun: settings?.issueOnRun ?? false,
            specOnRun: settings?.specOnRun ?? false,
            movedAt: now,
            captureId: capture.id,
            sourceSessionId: capture.sessionId,
            captureWhy: card.why,
            captureConfidence: card.confidence,
            evidence:
              evidence.length > 0
                ? evidence.map((e) => ({ ...e }))
                : Prisma.DbNull,
            fingerprint: card.fingerprint,
          },
          select: { id: true, number: true },
        });
        created.unshift(row);
      }
      await tx.cardCapture.update({
        where: { id: capture.id },
        data: { suggested: created.length },
      });
      const run = await tx.cardCapture.findUnique({
        where: { id: capture.id },
        select: { runId: true },
      });
      if (run?.runId) {
        await this.work.closeRun(
          tx,
          run.runId,
          'succeeded',
          `${created.length} suggested`,
        );
      }
      if (created.length > 0) {
        const event: CardsSuggestedEventData = {
          captureId: capture.id,
          sessionId: capture.sessionId,
          count: created.length,
          cardIds: created.map((c) => c.id),
        };
        await this.work.serverEvent(
          tx,
          project,
          CARDS_SUGGESTED_EVENT,
          capture.id,
          { ...event },
        );
      }
      return {
        created,
        runId: run?.runId ?? null,
        dropped: plan.dropped.length + plan.overflow.length,
      };
    });
    if (!applied) return;

    for (const card of applied.created) {
      await this.audit.record({
        ...BOARD_SYSTEM_ACTOR.ctx,
        action: 'card.captured',
        target: { type: 'board_card', id: card.id },
        projectId: project.id,
        after: { number: card.number, column: 'inbox' },
        result: 'ok',
        meta: { captureId: capture.id },
      });
      this.work.publish(project.id, card.id);
    }
    if (applied.runId) {
      this.work.publishRun(project.id, applied.runId, 'succeeded');
    }
  }

  /**
   * Marks a running capture `failed` and ends its run, once. A runner-side
   * failure is retried once on the same content (D7); a contract violation
   * is not — the same input would most likely break it again.
   */
  private async fail(
    captureId: string,
    error: string,
    retry: boolean,
    resultText?: string,
  ): Promise<void> {
    const now = new Date();
    const ended = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.cardCapture.updateMany({
        where: { id: captureId, status: 'running' },
        data: {
          status: 'failed',
          error: error.slice(0, ERROR_MAX),
          finishedAt: now,
          ...(resultText !== undefined ? { resultText } : {}),
        },
      });
      if (count === 0) return null;
      const capture = await tx.cardCapture.findUnique({
        where: { id: captureId },
        select: { runId: true, projectId: true, sessionId: true },
      });
      if (capture?.runId) {
        await this.work.closeRun(tx, capture.runId, 'failed', error);
      }
      return capture;
    });
    if (!ended) return;
    if (ended.runId) {
      this.work.publishRun(ended.projectId, ended.runId, 'failed');
    }
    if (retry) {
      try {
        await this.queue.retry(ended.sessionId, captureId);
      } catch (e) {
        this.logger.warn(
          `capture ${captureId}: retry not queued: ${(e as Error).message}`,
        );
      }
    }
  }

  private isRetry(args: Prisma.JsonValue): boolean {
    return (
      typeof args === 'object' &&
      args !== null &&
      !Array.isArray(args) &&
      typeof args.retryOf === 'string'
    );
  }

  /** The session's watermark: its newest capture's `contentToId`. */
  private async watermark(sessionId: string): Promise<bigint | null> {
    const last = await this.prisma.cardCapture.aggregate({
      where: { sessionId },
      _max: { contentToId: true },
    });
    const id = last._max.contentToId;
    return id === null || id === 0n ? null : id;
  }

  private async skip(
    session: CaptureSession,
    watermark: bigint | null,
    reason: CaptureSkipReason,
    inputChars: number,
    now: Date,
  ): Promise<ExtractOutcome> {
    const capture = await this.prisma.cardCapture.create({
      data: {
        projectId: session.projectId,
        sessionId: session.id,
        contentFromId: watermark ?? 0n,
        contentToId: watermark ?? 0n,
        inputChars,
        status: 'skipped',
        skipReason: reason,
        finishedAt: now,
      },
      select: { id: true },
    });
    return { kind: 'skipped', captureId: capture.id, reason };
  }

  /** D7: one running extraction per project. */
  private async busy(
    projectId: string,
    db: Tx | PrismaService = this.prisma,
  ): Promise<boolean> {
    const running = await db.cardCapture.count({
      where: { projectId, status: 'running' },
    });
    return running >= CAPTURE_MAX_RUNNING_PER_PROJECT;
  }

  /** A running capture whose result never came is failed, so the project is not stuck. */
  private async giveUpStale(projectId: string, now: Date): Promise<void> {
    const stale = await this.prisma.cardCapture.findMany({
      where: {
        projectId,
        status: 'running',
        createdAt: { lt: new Date(now.getTime() - CAPTURE_STALE_MS) },
      },
      select: { id: true },
    });
    for (const capture of stale) {
      await this.fail(capture.id, 'no result from the runner', false);
    }
  }

  private async lockProject(tx: Tx, projectId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`card-capture:${projectId}`}))`;
  }
}
