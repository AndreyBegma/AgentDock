import { rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import {
  ATTACHMENT_REFUSAL,
  ATTACHMENT_VIDEO_MAX_BYTES,
  attachmentContentPath,
  BOARD_CHANGED_EVENT,
  type BoardChangedData,
  CARD_DEMO_EVENTS,
  type CardDemoView,
  cardLabel,
  DEMO_ACTIVE_STATUSES,
  DEMO_ERROR,
  DEMO_MERGE_WAIT_MS,
  DEMO_REASON_MAX,
  DEMO_STALE_MS,
  type DemoStatus,
  demoScenarioPath,
  isDemoActive,
  type Role,
  touchesDemoUiPaths,
} from '@nautelle/shared';
import {
  API_EVENT_SOURCE,
  type CommandErrorCode,
  type DemoStatusData,
} from '@nautelle/shared/protocol';
import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { CardDemo, Prisma } from '@prisma/client';
import { attachmentRefused } from '../attachments/attachment-error';
import { AttachmentStore } from '../attachments/attachment-store';
import { AttachmentsService } from '../attachments/attachments.service';
import { receiveUpload, UploadOverLimit } from '../attachments/upload-storage';
import { AuditService } from '../audit/audit.service';
import { type AuditContext, SYSTEM_ACTOR } from '../audit/audit.types';
import { cardNotFound } from '../board/board-error';
import { hiddenFrom } from '../board/inbox-access';
import { PrismaService } from '../database/prisma.service';
import { LiveService } from '../live/live.service';
import { bearerToken } from '../runners/credentials';
import { recordServerEvent } from '../server-events/server-events';
import { DemoRunner } from './demo-runner';
import { DemoSettingsService } from './demo-settings.service';
import { demoError, demoNotActive, demoNotFound } from './demos-error';

const ACTIVE = [...DEMO_ACTIVE_STATUSES];

const REQUESTED_BY = {
  requestedBy: { select: { name: true, email: true } },
} as const;

type DemoRow = CardDemo & {
  requestedBy: { name: string | null; email: string } | null;
};

const toView = (projectId: string, row: DemoRow): CardDemoView => ({
  id: row.id,
  round: row.round,
  status: row.status,
  trigger: row.trigger,
  reason: row.reason,
  scenarioPath: row.scenarioPath,
  attachmentId: row.attachmentId,
  contentUrl: row.attachmentId
    ? attachmentContentPath(projectId, row.attachmentId)
    : null,
  durationMs: row.durationMs,
  size: row.size,
  requestedByName: row.requestedBy
    ? (row.requestedBy.name ?? row.requestedBy.email)
    : null,
  createdAt: row.createdAt.toISOString(),
  startedAt: row.startedAt?.toISOString() ?? null,
  finishedAt: row.finishedAt?.toISOString() ?? null,
});

/** The demo a runner acts on, with what the upload needs of its card. */
export interface RunnerDemo {
  runnerId: string;
  demoId: string;
  projectId: string;
  cardId: string;
  cardNumber: number;
}

/** What the runner says of the video it uploads. */
export interface DemoVideoUpload {
  /** The request, read as the raw body. */
  body: Readable;
  contentLength: number | null;
  sha256: string;
  durationMs: number | null;
}

const SHA256 = /^[a-f0-9]{64}$/;

/** C-370: what a demo of the card is recorded on — its project's runner. */
export interface DemoProject {
  id: string;
  runnerId: string;
  rootPath: string;
  repo: string;
}

/** C-370: what the automatic trigger reads of a card. */
export interface DemoCard {
  id: string;
  number: number;
  title: string;
  kind: 'feature' | 'bug';
  shortId: string;
}

/**
 * C-370: the files the card's PR changes, as `pr.inspect` reads them on the
 * runner — or why they could not be read.
 */
export type DemoPrFiles =
  | { files: readonly string[]; truncated: boolean }
  | { error: string };

/** The runner's refusals that say it cannot record, not that the card failed. */
const SKIPPING_ERRORS: ReadonlySet<CommandErrorCode> = new Set([
  'unknown_command',
  'disabled',
  'unsupported',
  'busy',
]);

/** Cards and heads whose PR touches no UI path, so `pr.inspect` runs once. */
const NO_UI_MEMO_MAX = 1_000;

const clipReason = (reason: string): string =>
  reason.length > DEMO_REASON_MAX
    ? `${reason.slice(0, DEMO_REASON_MAX - 1)}…`
    : reason;

/**
 * A card's demo recordings (C-368, ADR-0090): the list any member reads,
 * "Record again" (operator and above), the runner's video upload and secret
 * fetch, and the `demo.status` events that move a demo. A demo moves only
 * while it is queued or recording, so a late event or a second upload never
 * reopens a finished one. A failed demo is a warning, never a gate.
 *
 * C-370 (ADR-0095): the Board records a feature card's green head that
 * touches the project's UI paths (`autoRecord`), once per head; a newer head
 * supersedes a demo in flight; auto-merge waits for a demo in flight, at most
 * `DEMO_MERGE_WAIT_MS` (`holdsMerge`). A demo ready or failed is an activity
 * entry and never sets the card's `needsPerson`.
 */
@Injectable()
export class CardDemosService {
  private readonly logger = new Logger(CardDemosService.name);
  private readonly settledListeners: ((cardId: string) => void)[] = [];
  private readonly noUi = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly attachments: AttachmentsService,
    private readonly store: AttachmentStore,
    private readonly settings: DemoSettingsService,
    private readonly live: LiveService,
    private readonly runner: DemoRunner,
  ) {}

  /** C-370: called with the card's id once a demo is ready, failed or skipped. */
  onSettled(listener: (cardId: string) => void): void {
    this.settledListeners.push(listener);
  }

  /** Newest first. An Inbox card is an operator's only, as on the board. */
  async list(
    projectId: string,
    number: number,
    role: Role,
  ): Promise<CardDemoView[]> {
    const card = await this.card(projectId, number, role);
    const rows = await this.prisma.cardDemo.findMany({
      where: { cardId: card.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: REQUESTED_BY,
    });
    return rows.map((row) => toView(projectId, row));
  }

  /**
   * "Record again": records the card's latest round now and sends `card.demo`
   * to the project's runner (C-370). 409 with demo videos off, for a card in
   * Completed, one without a PR or one that never ran, and with a demo
   * already queued or recording — checked under the card's row lock. A demo
   * in flight for longer than `DEMO_STALE_MS` was lost by its runner: it is
   * failed and this one takes its place. A runner that cannot record skips
   * the demo with the reason.
   */
  async request(
    projectId: string,
    number: number,
    role: Role,
    userId: string,
    ctx: AuditContext,
  ): Promise<CardDemoView> {
    const card = await this.card(projectId, number, role);
    if (!(await this.settings.view(projectId)).enabled) {
      throw demoError(
        409,
        DEMO_ERROR.disabled,
        'Demo videos are off for this project',
      );
    }
    if (card.column === 'completed') {
      throw demoError(
        409,
        DEMO_ERROR.completed,
        'The card is completed; its demo is no longer recorded',
      );
    }
    if (card.prNumber === null) {
      throw demoError(
        409,
        DEMO_ERROR.noPullRequest,
        'The card has no pull request, so there is nothing to record',
      );
    }
    const { row, stale } = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM board_cards WHERE id = ${card.id} FOR UPDATE`;
      const latest = await tx.boardCardRound.findFirst({
        where: { cardId: card.id },
        orderBy: { round: 'desc' },
        select: { round: true, headSha: true },
      });
      if (!latest) {
        throw demoError(
          409,
          DEMO_ERROR.noRound,
          'The card has never run, so there is nothing to record',
        );
      }
      const inFlight = await tx.cardDemo.findMany({
        where: { cardId: card.id, status: { in: ACTIVE } },
        select: { id: true, createdAt: true },
      });
      const staleBefore = Date.now() - DEMO_STALE_MS;
      if (inFlight.some((demo) => demo.createdAt.getTime() >= staleBefore)) {
        throw demoError(
          409,
          DEMO_ERROR.inFlight,
          'The card already has a demo queued or recording',
        );
      }
      const stale = inFlight.map((demo) => demo.id);
      if (stale.length > 0) {
        await tx.cardDemo.updateMany({
          where: { id: { in: stale } },
          data: {
            status: 'failed',
            reason: 'The runner never finished the demo',
            finishedAt: new Date(),
          },
        });
      }
      const row = await tx.cardDemo.create({
        data: {
          cardId: card.id,
          round: latest.round,
          headSha: card.ciHeadSha ?? latest.headSha,
          trigger: 'manual',
          scenarioPath: demoScenarioPath(card),
          requestedById: userId,
        },
        include: REQUESTED_BY,
      });
      return { row, stale };
    });
    for (const demoId of stale) await this.failedEvent(demoId);
    await this.audit.record({
      ...ctx,
      action: 'demo.requested',
      target: { type: 'board_card', id: card.id },
      projectId,
      after: {
        cardId: card.id,
        number: card.number,
        demoId: row.id,
        round: row.round,
      },
      result: 'ok',
    });
    await this.dispatch(card.project, card, row, ctx);
    this.publish(projectId, card.id);
    const after = await this.prisma.cardDemo.findUniqueOrThrow({
      where: { id: row.id },
      include: REQUESTED_BY,
    });
    return toView(projectId, after);
  }

  /**
   * C-370: the Board's trigger, on a feature card's green head that passed
   * review. Once per head, whatever came of it, so nothing retries: a head
   * with a demo — automatic or "Record again" — is left alone. The PR's
   * changed files decide: one that touches no `demoUiPaths` glob gets no
   * demo (a list `pr.inspect` truncated counts as what it shows). Never
   * throws for the runner, and never blocks the card.
   */
  async autoRecord(
    project: DemoProject,
    card: DemoCard,
    headSha: string,
    inspect: () => Promise<DemoPrFiles>,
  ): Promise<void> {
    if (card.kind !== 'feature') return;
    const memo = `${card.id}:${headSha}`;
    if (this.noUi.has(memo)) return;
    const settings = await this.settings.view(project.id);
    if (!settings.enabled) return;
    const recorded = await this.prisma.cardDemo.count({
      where: { cardId: card.id, headSha },
    });
    if (recorded > 0) return;
    const pr = await inspect();
    if ('files' in pr && !touchesDemoUiPaths(pr.files, settings.uiPaths)) {
      if (this.noUi.size >= NO_UI_MEMO_MAX) this.noUi.clear();
      this.noUi.add(memo);
      return;
    }
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM board_cards WHERE id = ${card.id} FOR UPDATE`;
      const again = await tx.cardDemo.count({
        where: { cardId: card.id, headSha },
      });
      if (again > 0) return null;
      const latest = await tx.boardCardRound.findFirst({
        where: { cardId: card.id },
        orderBy: { round: 'desc' },
        select: { round: true },
      });
      if (!latest) return null;
      return tx.cardDemo.create({
        data: {
          cardId: card.id,
          round: latest.round,
          headSha,
          trigger: 'auto',
          scenarioPath: demoScenarioPath(card),
        },
      });
    });
    if (!row) return;
    this.logger.log(
      `${cardLabel(card.number)}: demo ${row.id} of ${headSha.slice(0, 8)} queued`,
    );
    if ('error' in pr) {
      await this.settle(
        row.id,
        'skipped',
        `The PR's changed files were not read: ${pr.error}`,
      );
    } else {
      await this.dispatch(project, card, row, { actor: SYSTEM_ACTOR });
    }
    this.publish(project.id, card.id);
  }

  /**
   * C-370: a demo in flight of another head than the PR's is superseded —
   * skipped with the reason; the new head gets its own. A demo whose head is
   * unknown is left to finish.
   */
  async supersede(
    projectId: string,
    cardId: string,
    headSha: string,
  ): Promise<void> {
    const { count } = await this.prisma.cardDemo.updateMany({
      where: {
        cardId,
        status: { in: ACTIVE },
        AND: [{ headSha: { not: null } }, { headSha: { not: headSha } }],
      },
      data: {
        status: 'skipped',
        reason: `Superseded by the newer head ${headSha.slice(0, 7)}`,
        finishedAt: new Date(),
      },
    });
    if (count > 0) this.publish(projectId, cardId);
  }

  /**
   * C-370: whether auto-merge waits for the card's demo — one is queued or
   * recording, and was asked for less than `DEMO_MERGE_WAIT_MS` ago.
   */
  async holdsMerge(cardId: string, now: number = Date.now()): Promise<boolean> {
    const inFlight = await this.prisma.cardDemo.count({
      where: {
        cardId,
        status: { in: ACTIVE },
        createdAt: { gt: new Date(now - DEMO_MERGE_WAIT_MS) },
      },
    });
    return inFlight > 0;
  }

  /**
   * The runner routes' check, before a byte of the body is read: 401 without
   * a valid runner token, 404 for a demo that is not there, 403 for a demo of
   * a project another runner serves, 409 once the demo is finished.
   */
  async forRunner(
    authorization: string | undefined,
    number: number,
    demoId: string,
  ): Promise<RunnerDemo> {
    const token = bearerToken(authorization);
    const runnerId = token ? await this.attachments.runnerOf(token) : null;
    if (!runnerId)
      throw new UnauthorizedException('A runner token is required');
    const row = await this.prisma.cardDemo.findFirst({
      where: { id: demoId, card: { number } },
      select: {
        status: true,
        card: {
          select: {
            id: true,
            projectId: true,
            project: { select: { runnerId: true } },
          },
        },
      },
    });
    if (!row) throw demoNotFound();
    if (row.card.project.runnerId !== runnerId) {
      throw new ForbiddenException(
        'The demo belongs to a project of another runner',
      );
    }
    if (!isDemoActive(row.status)) throw demoNotActive();
    return {
      runnerId,
      demoId,
      projectId: row.card.projectId,
      cardId: row.card.id,
      cardNumber: number,
    };
  }

  /** `GET /runner/cards/:n/demos/:demoId/env`: the project's secrets, opened. */
  async env(demo: RunnerDemo): Promise<Record<string, string>> {
    return this.settings.openSecrets(demo.projectId);
  }

  /**
   * `POST /runner/cards/:n/demos/:demoId/video`: streams the body to a
   * temporary file — at most `ATTACHMENT_VIDEO_MAX_BYTES` — checks its SHA-256
   * against the header and that it is an MP4 or WebM by content, then stores
   * it on the card and makes the demo ready. The demo is re-checked under its
   * row lock, so two uploads cannot both land.
   */
  async upload(
    demo: RunnerDemo,
    input: DemoVideoUpload,
  ): Promise<CardDemoView> {
    if (!SHA256.test(input.sha256)) {
      throw demoError(
        422,
        DEMO_ERROR.integrity,
        'x-demo-sha256 must be the lower-case hex SHA-256 of the body',
      );
    }
    if (
      input.contentLength !== null &&
      input.contentLength > ATTACHMENT_VIDEO_MAX_BYTES
    ) {
      throw this.attachments.tooLarge('video/mp4');
    }
    let file: Awaited<ReturnType<typeof receiveUpload>>;
    try {
      file = await receiveUpload(
        input.body,
        this.store,
        ATTACHMENT_VIDEO_MAX_BYTES,
      );
    } catch (error) {
      if (error instanceof UploadOverLimit) {
        throw this.attachments.tooLarge('video/mp4');
      }
      throw error;
    }
    try {
      if (file.size === 0) {
        throw attachmentRefused(
          ATTACHMENT_REFUSAL.unsupportedType,
          'A demo video must be an MP4 or WebM file',
        );
      }
      if (file.sha256 !== input.sha256) {
        throw demoError(
          422,
          DEMO_ERROR.integrity,
          'The body does not match x-demo-sha256',
        );
      }
      const row = await this.prisma.$transaction(async (tx) => {
        await this.lockActive(tx, demo.demoId);
        const ext = file.head[0] === 0x1a ? 'webm' : 'mp4';
        const attachment = await this.attachments.addVideo(
          tx,
          { projectId: demo.projectId, cardId: demo.cardId },
          `${cardLabel(demo.cardNumber)}-demo.${ext}`,
          { ...file, originalname: `demo.${ext}` },
        );
        const ready = await tx.cardDemo.update({
          where: { id: demo.demoId },
          data: {
            status: 'ready',
            reason: null,
            attachmentId: attachment.id,
            size: attachment.size,
            durationMs: input.durationMs,
            finishedAt: new Date(),
          },
          include: REQUESTED_BY,
        });
        await this.activity(tx, CARD_DEMO_EVENTS.ready, demo.demoId);
        return ready;
      });
      await this.audit.record({
        actor: { type: 'runner', runnerId: demo.runnerId },
        action: 'demo.video_uploaded',
        target: { type: 'board_card', id: demo.cardId },
        projectId: demo.projectId,
        after: {
          cardId: demo.cardId,
          demoId: demo.demoId,
          attachmentId: row.attachmentId,
          size: row.size,
        },
        result: 'ok',
      });
      this.publish(demo.projectId, demo.cardId);
      this.settled(demo.cardId);
      return toView(demo.projectId, row);
    } finally {
      // Moved into place on success; anything else is not kept.
      await rm(file.path, { force: true });
    }
  }

  /**
   * `demo.status` from the runner: `recording` starts a queued demo,
   * `failed` and `skipped` finish an active one with the reason. Only a demo
   * of a project the runner serves; anything else is ignored, as a replayed
   * or late event is.
   */
  async status(runnerId: string, data: DemoStatusData): Promise<void> {
    const demo = await this.prisma.cardDemo.findFirst({
      where: {
        id: data.demoId,
        cardId: data.cardId,
        card: { projectId: data.projectId, project: { runnerId } },
      },
      select: { id: true, status: true },
    });
    if (!demo || !isDemoActive(demo.status)) {
      this.logger.debug(
        `runner ${runnerId}: demo.status ${data.status} for demo ${data.demoId} ignored`,
      );
      return;
    }
    const at = new Date(data.at);
    const scenario = data.scenarioPath
      ? { scenarioPath: data.scenarioPath }
      : {};
    const from: DemoStatus[] =
      data.status === 'recording' ? ['queued'] : ACTIVE;
    const { count } = await this.prisma.cardDemo.updateMany({
      where: { id: demo.id, status: { in: from } },
      data:
        data.status === 'recording'
          ? { status: 'recording', startedAt: at, ...scenario }
          : {
              status: data.status,
              reason: data.reason ?? null,
              finishedAt: at,
              ...scenario,
            },
    });
    if (count === 0) return;
    if (data.status === 'failed') await this.failedEvent(demo.id);
    this.publish(data.projectId, data.cardId);
    if (data.status !== 'recording') this.settled(data.cardId);
  }

  /**
   * C-370: sends `card.demo` for a queued demo. A runner that cannot take it
   * skips the demo with the reason; a refusal of the card's own fails it; no
   * answer within the timeout leaves it queued — the runner may still have
   * it, and `DEMO_MERGE_WAIT_MS` caps the wait.
   */
  private async dispatch(
    project: DemoProject,
    card: DemoCard,
    demo: { id: string; round: number; scenarioPath: string | null },
    ctx: AuditContext,
  ): Promise<void> {
    const unavailable = await this.runner.unavailable(project.runnerId);
    if (unavailable !== null) {
      await this.settle(demo.id, 'skipped', unavailable);
      return;
    }
    const secrets = await this.prisma.projectDemoSecret.findMany({
      where: { projectId: project.id },
      orderBy: { name: 'asc' },
      select: { name: true },
    });
    let result: Awaited<ReturnType<DemoRunner['record']>>;
    try {
      result = await this.runner.record(
        project.runnerId,
        {
          cardId: card.id,
          projectId: project.id,
          card: card.number,
          round: demo.round,
          demoId: demo.id,
          worktree: { root: project.rootPath, shortId: card.shortId },
          scenario: demo.scenarioPath ?? demoScenarioPath(card),
          env: secrets.map((s) => s.name),
        },
        ctx,
      );
    } catch (error) {
      result = {
        status: 'error',
        error: { code: 'internal', message: (error as Error).message },
      };
    }
    if (result.status !== 'error') return;
    const { code, message } = result.error;
    await this.settle(
      demo.id,
      SKIPPING_ERRORS.has(code) ? 'skipped' : 'failed',
      `The runner refused the demo (${code})${message ? `: ${message}` : ''}`,
    );
  }

  /** Finishes a demo still in flight; a failed one is an activity entry. */
  private async settle(
    demoId: string,
    status: 'failed' | 'skipped',
    reason: string,
  ): Promise<void> {
    const row = await this.prisma.cardDemo.findUnique({
      where: { id: demoId },
      select: { cardId: true },
    });
    if (!row) return;
    const { count } = await this.prisma.cardDemo.updateMany({
      where: { id: demoId, status: { in: ACTIVE } },
      data: { status, reason: clipReason(reason), finishedAt: new Date() },
    });
    if (count === 0) return;
    if (status === 'failed') await this.failedEvent(demoId);
    this.settled(row.cardId);
  }

  private async failedEvent(demoId: string): Promise<void> {
    await this.prisma.$transaction((tx) =>
      this.activity(tx, CARD_DEMO_EVENTS.failed, demoId),
    );
  }

  /**
   * C-370: `card.demo_ready` / `card.demo_failed` in the activity feed,
   * recorded by the API (ADR-0014) — once per demo.
   */
  private async activity(
    tx: Prisma.TransactionClient,
    type: string,
    demoId: string,
  ): Promise<void> {
    const demo = await tx.cardDemo.findUnique({
      where: { id: demoId },
      select: {
        id: true,
        round: true,
        trigger: true,
        reason: true,
        card: {
          select: {
            id: true,
            number: true,
            project: {
              select: { runnerId: true, rootPath: true, repo: true },
            },
          },
        },
      },
    });
    if (!demo) return;
    await recordServerEvent(tx, {
      source: API_EVENT_SOURCE,
      type,
      ts: new Date(),
      project: demo.card.project,
      data: {
        cardId: demo.card.id,
        number: demo.card.number,
        demoId: demo.id,
        round: demo.round,
        trigger: demo.trigger,
        ...(demo.reason !== null ? { reason: demo.reason } : {}),
      },
      dedupeKey: `${type}:${demo.id}`,
    });
  }

  private settled(cardId: string): void {
    for (const listener of this.settledListeners) {
      try {
        listener(cardId);
      } catch (error) {
        this.logger.warn(
          `a demo listener of ${cardId} failed: ${(error as Error).message}`,
        );
      }
    }
  }

  private async card(projectId: string, number: number, role: Role) {
    const card = await this.prisma.boardCard.findUnique({
      where: { projectId_number: { projectId, number } },
      select: {
        id: true,
        number: true,
        title: true,
        column: true,
        kind: true,
        shortId: true,
        prNumber: true,
        ciHeadSha: true,
        project: {
          select: { id: true, runnerId: true, rootPath: true, repo: true },
        },
      },
    });
    if (!card || hiddenFrom(card, role)) throw cardNotFound();
    return card;
  }

  private async lockActive(
    tx: Prisma.TransactionClient,
    demoId: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<{ status: DemoStatus }[]>`
      SELECT status::text AS status FROM card_demos WHERE id = ${demoId} FOR UPDATE`;
    if (rows.length === 0) throw demoNotFound();
    if (!isDemoActive(rows[0].status)) throw demoNotActive();
  }

  /** The card's sheet and tile refresh, as on any card change. */
  private publish(projectId: string, cardId: string): void {
    const data: BoardChangedData = { cardId };
    try {
      this.live.publish(`project:${projectId}`, BOARD_CHANGED_EVENT, data);
    } catch {
      // A missed live update is caught up by the next read.
    }
  }
}
