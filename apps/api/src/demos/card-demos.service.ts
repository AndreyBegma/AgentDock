import { rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import {
  ATTACHMENT_REFUSAL,
  ATTACHMENT_VIDEO_MAX_BYTES,
  attachmentContentPath,
  BOARD_CHANGED_EVENT,
  type BoardChangedData,
  CARD_DEMO_EVENT,
  type CardDemoEventData,
  type CardDemoView,
  cardLabel,
  DEMO_ACTIVE_STATUSES,
  DEMO_ERROR,
  type DemoStatus,
  demoScenarioPath,
  isDemoActive,
  type Role,
} from '@nautelle/shared';
import {
  API_EVENT_SOURCE,
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
import type { AuditContext } from '../audit/audit.types';
import { cardNotFound } from '../board/board-error';
import { hiddenFrom } from '../board/inbox-access';
import { PrismaService } from '../database/prisma.service';
import { LiveService } from '../live/live.service';
import { bearerToken } from '../runners/credentials';
import { recordServerEvent } from '../server-events/server-events';
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

/**
 * A card's demo recordings (C-368, ADR-0090): the list any member reads,
 * "Record again" (operator and above), the runner's video upload and secret
 * fetch, and the `demo.status` events that move a demo. A demo moves only
 * while it is queued or recording, so a late event or a second upload never
 * reopens a finished one. A failed demo is a warning, never a gate.
 */
@Injectable()
export class CardDemosService {
  private readonly logger = new Logger(CardDemosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly attachments: AttachmentsService,
    private readonly store: AttachmentStore,
    private readonly settings: DemoSettingsService,
    private readonly live: LiveService,
  ) {}

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
   * "Record again": queues a manual demo of the card's latest round. 409 with
   * demo videos off, with a demo already queued or recording (checked under
   * the card's row lock), or for a card that never ran. Stage 1 only queues
   * the row; sending `card.demo` to the runner is S-12 stage 2.
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
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM board_cards WHERE id = ${card.id} FOR UPDATE`;
      const latest = await tx.boardCardRound.findFirst({
        where: { cardId: card.id },
        orderBy: { round: 'desc' },
        select: { round: true },
      });
      if (!latest) {
        throw demoError(
          409,
          DEMO_ERROR.noRound,
          'The card has never run, so there is nothing to record',
        );
      }
      const inFlight = await tx.cardDemo.count({
        where: { cardId: card.id, status: { in: ACTIVE } },
      });
      if (inFlight > 0) {
        throw demoError(
          409,
          DEMO_ERROR.inFlight,
          'The card already has a demo queued or recording',
        );
      }
      return tx.cardDemo.create({
        data: {
          cardId: card.id,
          round: latest.round,
          trigger: 'manual',
          scenarioPath: demoScenarioPath(card),
          requestedById: userId,
        },
        include: REQUESTED_BY,
      });
    });
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
    this.publish(projectId, card.id);
    return toView(projectId, row);
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
        await this.telegramEvent(tx, ready);
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
    const count = await this.prisma.$transaction(async (tx) => {
      const moved = await tx.cardDemo.updateMany({
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
      if (moved.count > 0 && data.status === 'failed') {
        const failed = await tx.cardDemo.findUniqueOrThrow({
          where: { id: demo.id },
        });
        await this.telegramEvent(tx, failed);
      }
      return moved.count;
    });
    if (count > 0) this.publish(data.projectId, data.cardId);
  }

  private async card(projectId: string, number: number, role: Role) {
    const card = await this.prisma.boardCard.findUnique({
      where: { projectId_number: { projectId, number } },
      select: { id: true, number: true, title: true, column: true },
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

  /**
   * C-372: the `card.demo` server event of a demo that became ready or
   * failed, in the transaction that moved it, so the Telegram message and the
   * demo commit together — only while the project's `demoTelegram` is on. A
   * skipped demo sends nothing.
   */
  private async telegramEvent(
    tx: Prisma.TransactionClient,
    demo: CardDemo,
  ): Promise<void> {
    if (demo.status !== 'ready' && demo.status !== 'failed') return;
    const card = await tx.boardCard.findUniqueOrThrow({
      where: { id: demo.cardId },
      select: {
        id: true,
        number: true,
        title: true,
        project: {
          select: {
            runnerId: true,
            rootPath: true,
            repo: true,
            boardSettings: { select: { demoTelegram: true } },
          },
        },
      },
    });
    if (!(card.project.boardSettings?.demoTelegram ?? true)) return;
    const data: CardDemoEventData = {
      cardId: card.id,
      number: card.number,
      title: card.title,
      round: demo.round,
      demoId: demo.id,
      status: demo.status,
      reason: demo.status === 'failed' ? demo.reason : null,
      size: demo.status === 'ready' ? demo.size : null,
    };
    await recordServerEvent(tx, {
      source: API_EVENT_SOURCE,
      type: CARD_DEMO_EVENT,
      ts: new Date(),
      project: {
        runnerId: card.project.runnerId,
        rootPath: card.project.rootPath,
        repo: card.project.repo,
      },
      data: { ...data },
      dedupeKey: `${CARD_DEMO_EVENT}:${demo.id}`,
    });
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
