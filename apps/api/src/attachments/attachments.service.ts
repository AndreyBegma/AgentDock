import { createHash, randomBytes } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import {
  ATTACHMENT_ERROR,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_PENDING_TTL_MS,
  ATTACHMENT_REFUSAL,
  ATTACHMENTS_PER_CARD_MAX,
  type AttachmentMime,
  type AttachmentRef,
  type AttachmentView,
  attachmentContentPath,
  attachmentDisplayName,
  type CardAttachmentBrief,
  detectAttachmentMime,
  isAttachmentMime,
  type Role,
} from '@agentdock/shared';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Attachment, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import {
  bearerToken,
  tokenPrefix,
  verifyRunnerToken,
} from '../runners/credentials';
import {
  AttachmentFailure,
  attachmentNotFound,
  attachmentRefused,
} from './attachment-error';
import { AttachmentStore } from './attachment-store';
import {
  ATTACHMENTS_OPTIONS,
  type AttachmentsOptions,
} from './attachments-options';
import { ATTACHMENT_ID_PATTERN } from './dto';

type Db = PrismaService | Prisma.TransactionClient;

/** Who acts — the board's `BoardActor`, structurally. */
export interface AttachmentActor {
  userId: string | null;
  role: Role;
  ctx: AuditContext;
}

/** What multer's disk storage hands the upload route (D12). */
export interface UploadedAttachment {
  originalname: string;
  path: string;
  size: number;
}

const UPLOADER = {
  uploader: { select: { email: true, name: true } },
} as const;

type AttachmentWithUploader = Attachment & {
  uploader: { email: string; name: string | null } | null;
};

/** Oldest first, then by id: the upload order `card.run` and the prompt use. */
const UPLOAD_ORDER: Prisma.AttachmentOrderByWithRelationInput[] = [
  { createdAt: 'asc' },
  { id: 'asc' },
];

/** A stored `mime` outside the allowlist never leaves the API (D5). */
const mimeOf = (row: Attachment): AttachmentMime => {
  if (!isAttachmentMime(row.mime)) {
    throw new Error(`attachment ${row.id} has a foreign type ${row.mime}`);
  }
  return row.mime;
};

const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** One card's attachments as the board needs them (#309 D9, D10). */
export interface CardAttachments {
  refs: AttachmentRef[];
  briefs: CardAttachmentBrief[];
}

export const toAttachmentRef = (row: Attachment): AttachmentRef => ({
  id: row.id,
  name: row.name,
  mime: mimeOf(row),
  size: row.size,
  sha256: row.sha256,
});

export const toAttachmentBrief = (row: Attachment): CardAttachmentBrief => ({
  id: row.id,
  name: row.name,
  mime: mimeOf(row),
});

export const toAttachmentView = (
  row: AttachmentWithUploader,
): AttachmentView => ({
  id: row.id,
  name: row.name,
  mime: mimeOf(row),
  size: row.size,
  createdAt: row.createdAt.toISOString(),
  uploaderId: row.uploaderId,
  uploaderName: row.uploader ? (row.uploader.name ?? row.uploader.email) : null,
  roundId: row.roundId,
  contentUrl: attachmentContentPath(row.projectId, row.id),
});

/** An attachment's bytes and what the response says about them. */
export interface AttachmentContent {
  name: string;
  mime: AttachmentMime;
  size: number;
  stream: Readable;
}

/**
 * Board card attachments (issue #309, ADR-0031): uploads, the bytes for a
 * member and for the project's runner, deletes, and the claims the board
 * makes inside its own transactions. Files are written and removed only
 * through the `AttachmentStore` port; a row is the source of truth, and a
 * file without one is the sweep's.
 */
@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: AttachmentStore,
    private readonly audit: AuditService,
    @Inject(ATTACHMENTS_OPTIONS) private readonly options: AttachmentsOptions,
  ) {}

  /**
   * `POST /attachments` (D3, D4, D5, D12): checks the uploaded temporary file
   * by its content, then stores it pending — bound to the project and the
   * uploader until a card claims it. The quota is checked under a per-project
   * lock, so concurrent uploads cannot both squeeze under it.
   */
  async upload(
    projectId: string,
    file: UploadedAttachment | undefined,
    actor: AttachmentActor,
  ): Promise<AttachmentView> {
    if (!file) {
      throw new BadRequestException('multipart field `file` is required');
    }
    try {
      if (file.size > ATTACHMENT_MAX_BYTES) throw this.tooLarge();
      const bytes = new Uint8Array(await readFile(file.path));
      if (bytes.byteLength > ATTACHMENT_MAX_BYTES) throw this.tooLarge();
      const name = attachmentDisplayName(file.originalname);
      const mime = detectAttachmentMime(bytes, file.originalname);
      if (mime === null) {
        throw attachmentRefused(
          ATTACHMENT_REFUSAL.unsupportedType,
          'Only PNG, JPEG, GIF, WebP, PDF and plain text files (.txt .md .log .csv .json .diff .patch) can be attached',
        );
      }
      const now = new Date();
      const row = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`attachments-quota:${projectId}`}))`;
        const used = await tx.attachment.aggregate({
          where: { projectId },
          _sum: { size: true },
        });
        const total = (used._sum.size ?? 0) + bytes.byteLength;
        if (total > this.options.projectQuotaBytes) {
          throw attachmentRefused(
            ATTACHMENT_REFUSAL.quotaExceeded,
            'The project has no room left for attachments',
          );
        }
        const created = await tx.attachment.create({
          data: {
            projectId,
            uploaderId: actor.userId,
            name,
            mime,
            size: bytes.byteLength,
            sha256: sha256(bytes),
            expiresAt: new Date(now.getTime() + ATTACHMENT_PENDING_TTL_MS),
            createdAt: now,
          },
          include: UPLOADER,
        });
        // Before commit: a failed move leaves no row. A failed commit leaves
        // a file without a row, which the sweep removes.
        await this.store.put(projectId, created.id, file.path);
        return created;
      });
      await this.audit.record({
        ...actor.ctx,
        action: 'attachment.added',
        target: { type: 'attachment', id: row.id },
        projectId,
        after: { name: row.name, mime: row.mime, size: row.size },
        result: 'ok',
      });
      return toAttachmentView(row);
    } finally {
      // Moved into place on success; anything else is not kept.
      await rm(file.path, { force: true });
    }
  }

  /**
   * #594: `upload` for bytes that did not come through the upload route — a
   * Telegram photo. They go through the same temporary file, checks and quota.
   */
  async uploadBytes(
    projectId: string,
    name: string,
    bytes: Uint8Array,
    actor: AttachmentActor,
  ): Promise<AttachmentView> {
    if (bytes.byteLength > ATTACHMENT_MAX_BYTES) throw this.tooLarge();
    const path = join(
      await this.store.tempDir(),
      randomBytes(16).toString('hex'),
    );
    await writeFile(path, bytes, { flag: 'wx' });
    return this.upload(
      projectId,
      { originalname: name, path, size: bytes.byteLength },
      actor,
    );
  }

  tooLarge(): AttachmentFailure {
    return attachmentRefused(
      ATTACHMENT_REFUSAL.tooLarge,
      `A file can be at most ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MiB`,
    );
  }

  /**
   * `GET …/content` (D8): any member reads a claimed attachment; a pending
   * one is its uploader's alone until a card claims it.
   */
  async content(
    projectId: string,
    id: string,
    userId: string,
  ): Promise<AttachmentContent> {
    const row = await this.prisma.attachment.findFirst({
      where: { id, projectId },
    });
    if (!row || (row.cardId === null && row.uploaderId !== userId)) {
      throw attachmentNotFound();
    }
    return this.bytesOf(row);
  }

  /**
   * `GET /runner/attachments/:id` (D9): the runner's own token, and only an
   * attachment on a card of a project that runner serves. 401 without a valid
   * token; 404 for anything else, so a runner learns nothing of other projects.
   */
  async forRunner(
    authorization: string | undefined,
    id: string,
  ): Promise<AttachmentContent> {
    const token = bearerToken(authorization);
    const runner = token ? await this.runnerOf(token) : null;
    if (!runner) throw new UnauthorizedException('A runner token is required');
    if (!ATTACHMENT_ID_PATTERN.test(id)) throw attachmentNotFound();
    const row = await this.prisma.attachment.findFirst({
      // A card's, or a card intake's (#337 D10) — never a pending upload.
      where: {
        id,
        OR: [{ cardId: { not: null } }, { planId: { not: null } }],
        project: { runnerId: runner },
      },
    });
    if (!row) throw attachmentNotFound();
    return this.bytesOf(row);
  }

  /** `RunnerIngestService.authenticate`: the runner's id, or `null`. */
  private async runnerOf(token: string): Promise<string | null> {
    const runner = await this.prisma.runner.findUnique({
      where: { tokenPrefix: tokenPrefix(token) },
      select: { id: true, tokenHash: true, revokedAt: true },
    });
    if (!runner?.tokenHash || runner.revokedAt) return null;
    return (await verifyRunnerToken(runner.tokenHash, token))
      ? runner.id
      : null;
  }

  private async bytesOf(row: Attachment): Promise<AttachmentContent> {
    let stream: Readable;
    try {
      stream = await this.store.open(row.projectId, row.id);
    } catch (error) {
      this.logger.error(
        `attachment ${row.id} has a row and no file: ${(error as Error).message}`,
      );
      throw attachmentNotFound();
    }
    return { name: row.name, mime: mimeOf(row), size: row.size, stream };
  }

  /**
   * `DELETE /attachments/:id` (D7): the uploader, or an admin of the project.
   * A pending upload of someone else is not there; a card in Completed keeps
   * its attachments. Returns the card it was on, for the board's live update.
   */
  async remove(
    projectId: string,
    id: string,
    actor: AttachmentActor,
  ): Promise<{ cardId: string | null }> {
    const row = await this.prisma.attachment.findFirst({
      where: { id, projectId },
      include: { card: { select: { column: true } } },
    });
    if (!row || (row.cardId === null && row.uploaderId !== actor.userId)) {
      throw attachmentNotFound();
    }
    if (actor.role !== 'admin' && row.uploaderId !== actor.userId) {
      throw new ForbiddenException(
        'Only its uploader or an admin deletes an attachment',
      );
    }
    if (row.card?.column === 'completed') {
      throw new AttachmentFailure(
        409,
        ATTACHMENT_ERROR.cardCompleted,
        'Attachments of a completed card do not change',
      );
    }
    await this.prisma.attachment.delete({ where: { id: row.id } });
    await this.removeFiles(projectId, [row.id]);
    await this.audit.record({
      ...actor.ctx,
      action: 'attachment.removed',
      target: { type: 'attachment', id: row.id },
      projectId,
      before: { name: row.name, cardId: row.cardId },
      result: 'ok',
    });
    return { cardId: row.cardId };
  }

  /**
   * D3: refuses before anything is written — each id must be pending, in
   * this project, uploaded by the caller and not yet expired, and the card
   * must have room. `cardId` null is a card not created yet.
   */
  async assertClaimable(
    projectId: string,
    cardId: string | null,
    ids: readonly string[],
    actor: Pick<AttachmentActor, 'userId'>,
    db: Db = this.prisma,
  ): Promise<void> {
    if (ids.length === 0) return;
    const claimable = await db.attachment.count({
      where: this.pendingOf(projectId, ids, actor.userId),
    });
    if (claimable !== ids.length) throw this.notClaimable();
    await this.assertRoom(cardId, ids.length, db);
  }

  /**
   * D3: claims pending uploads onto a card (and a round's feedback), inside
   * the caller's transaction, which holds the card's row lock. Re-checks
   * everything `assertClaimable` did, so a concurrent claim or sweep cannot
   * slip between the check and the write.
   */
  async claim(
    tx: Prisma.TransactionClient,
    target: { projectId: string; cardId: string; roundId?: string | null },
    ids: readonly string[],
    actor: Pick<AttachmentActor, 'userId'>,
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.assertRoom(target.cardId, ids.length, tx);
    const { count } = await tx.attachment.updateMany({
      where: this.pendingOf(target.projectId, ids, actor.userId),
      data: {
        cardId: target.cardId,
        roundId: target.roundId ?? null,
        expiresAt: null,
      },
    });
    if (count !== ids.length) throw this.notClaimable();
  }

  /** `attachment.claimed` (D7), once the claim has committed. */
  async recordClaim(
    projectId: string,
    target: { cardId: string; roundId?: string | null },
    ids: readonly string[],
    actor: AttachmentActor,
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.audit.record({
      ...actor.ctx,
      action: 'attachment.claimed',
      target: { type: 'board_card', id: target.cardId },
      projectId,
      after: {
        cardId: target.cardId,
        ...(target.roundId ? { roundId: target.roundId } : {}),
        attachmentIds: [...ids],
      },
      result: 'ok',
    });
  }

  /**
   * #337 D6, D10: refuses before anything is written — like `assertClaimable`
   * for a card, with the room counted on the plan, whose card takes them all.
   */
  async assertPlanClaimable(
    projectId: string,
    planId: string | null,
    ids: readonly string[],
    actor: Pick<AttachmentActor, 'userId'>,
  ): Promise<void> {
    if (ids.length === 0) return;
    const claimable = await this.prisma.attachment.count({
      where: this.pendingOf(projectId, ids, actor.userId),
    });
    if (claimable !== ids.length) throw this.notClaimable();
    await this.assertPlanRoom(planId, ids.length, this.prisma);
  }

  /**
   * #337 D10: a card intake claims pending uploads while it runs — `planId`
   * set, `expiresAt` cleared — inside the caller's transaction. Re-checks
   * what `assertPlanClaimable` did.
   */
  async claimForPlan(
    tx: Prisma.TransactionClient,
    target: { projectId: string; planId: string },
    ids: readonly string[],
    actor: Pick<AttachmentActor, 'userId'>,
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.assertPlanRoom(target.planId, ids.length, tx);
    const { count } = await tx.attachment.updateMany({
      where: this.pendingOf(target.projectId, ids, actor.userId),
      data: { planId: target.planId, expiresAt: null },
    });
    if (count !== ids.length) throw this.notClaimable();
  }

  /**
   * #337 D10: every attachment of the plan so far, and `claiming` — checked
   * with `assertPlanClaimable`, about to join it — in upload order: each
   * `plan.turn` carries them all.
   */
  async planRefs(
    planId: string,
    claiming: readonly string[] = [],
  ): Promise<AttachmentRef[]> {
    const rows = await this.prisma.attachment.findMany({
      where: {
        OR: [
          { planId },
          ...(claiming.length > 0 ? [{ id: { in: [...claiming] } }] : []),
        ],
      },
      orderBy: UPLOAD_ORDER,
    });
    return rows.map(toAttachmentRef);
  }

  /** #594: the plan's attachments as the intake view shows them, oldest first. */
  async planViews(planId: string): Promise<AttachmentView[]> {
    const rows = await this.prisma.attachment.findMany({
      where: { planId },
      orderBy: UPLOAD_ORDER,
      include: UPLOADER,
    });
    return rows.map(toAttachmentView);
  }

  /** #594: how many attachments the plan holds — its card's room. */
  countOfPlan(planId: string): Promise<number> {
    return this.prisma.attachment.count({ where: { planId } });
  }

  /**
   * #337 D6: the generated card re-claims its intake's attachments, inside
   * the transaction that creates it. Returns their ids.
   */
  async claimPlanOntoCard(
    tx: Prisma.TransactionClient,
    planId: string,
    cardId: string,
  ): Promise<string[]> {
    const rows = await tx.attachment.findMany({
      where: { planId, cardId: null },
      select: { id: true },
    });
    if (rows.length === 0) return [];
    await tx.attachment.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { cardId },
    });
    return rows.map((r) => r.id);
  }

  /**
   * #337 D2: a discarded intake made no card — its attachments go back to the
   * sweep, which removes them with their files.
   */
  async releasePlan(planId: string): Promise<void> {
    await this.prisma.attachment.updateMany({
      where: { planId, cardId: null },
      data: { expiresAt: new Date() },
    });
  }

  private async assertPlanRoom(
    planId: string | null,
    adding: number,
    db: Db,
  ): Promise<void> {
    const held =
      planId === null ? 0 : await db.attachment.count({ where: { planId } });
    if (held + adding > ATTACHMENTS_PER_CARD_MAX) {
      throw attachmentRefused(
        ATTACHMENT_REFUSAL.tooMany,
        `A card holds at most ${ATTACHMENTS_PER_CARD_MAX} attachments`,
      );
    }
  }

  private pendingOf(
    projectId: string,
    ids: readonly string[],
    userId: string | null,
  ): Prisma.AttachmentWhereInput {
    // Without a user there is no uploader to match: nothing is claimable.
    return {
      id: { in: [...ids] },
      projectId,
      cardId: null,
      // #337: an intake's upload is claimed, though it has no card yet.
      planId: null,
      uploaderId: userId ?? '',
      expiresAt: { gt: new Date() },
    };
  }

  /** D4: at most `ATTACHMENTS_PER_CARD_MAX` on a card, its rounds' included. */
  private async assertRoom(
    cardId: string | null,
    adding: number,
    db: Db,
  ): Promise<void> {
    const held =
      cardId === null ? 0 : await db.attachment.count({ where: { cardId } });
    if (held + adding > ATTACHMENTS_PER_CARD_MAX) {
      throw attachmentRefused(
        ATTACHMENT_REFUSAL.tooMany,
        `A card holds at most ${ATTACHMENTS_PER_CARD_MAX} attachments`,
      );
    }
  }

  notClaimable(): AttachmentFailure {
    return attachmentRefused(
      ATTACHMENT_REFUSAL.notClaimable,
      'An attachment is not a pending upload of yours in this project',
    );
  }

  /** D9, D10: the card's attachments, its rounds' included, in upload order. */
  async ofCard(cardId: string, db: Db = this.prisma): Promise<Attachment[]> {
    return db.attachment.findMany({
      where: { cardId },
      orderBy: UPLOAD_ORDER,
    });
  }

  /**
   * D9: what a card will hold once `claimIds` — already checked with
   * `assertClaimable` — are claimed onto it, in upload order.
   */
  async withClaim(
    cardId: string,
    claimIds: readonly string[],
  ): Promise<Attachment[]> {
    return this.prisma.attachment.findMany({
      where: {
        OR: [
          { cardId },
          ...(claimIds.length > 0
            ? [{ id: { in: [...claimIds] }, cardId: null }]
            : []),
        ],
      },
      orderBy: UPLOAD_ORDER,
    });
  }

  /** `BoardCardDetail.attachments`: oldest first. */
  async views(cardId: string): Promise<AttachmentView[]> {
    const rows = await this.prisma.attachment.findMany({
      where: { cardId },
      orderBy: UPLOAD_ORDER,
      include: UPLOADER,
    });
    return rows.map(toAttachmentView);
  }

  /** `BoardCardView.attachmentCount` of each card; a card without any is absent. */
  async counts(cardIds: readonly string[]): Promise<Map<string, number>> {
    if (cardIds.length === 0) return new Map();
    const groups = await this.prisma.attachment.groupBy({
      by: ['cardId'],
      where: { cardId: { in: [...cardIds] } },
      _count: { _all: true },
    });
    return new Map(
      groups.flatMap((g) =>
        g.cardId === null ? [] : [[g.cardId, g._count._all] as const],
      ),
    );
  }

  /** The ids of a card's attachments, read inside the card delete (D11). */
  async idsOfCard(tx: Prisma.TransactionClient, cardId: string) {
    const rows = await tx.attachment.findMany({
      where: { cardId },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * D11: files of rows already deleted, after the delete committed. A file
   * that cannot be removed now is the sweep's: it has no row.
   */
  async removeFiles(projectId: string, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      try {
        await this.store.remove(projectId, id);
      } catch (error) {
        this.logger.warn(
          `attachment file ${id} not removed: ${(error as Error).message}`,
        );
      }
    }
  }
}
