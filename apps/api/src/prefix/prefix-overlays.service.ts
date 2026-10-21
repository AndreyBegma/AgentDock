import {
  compressedRulesSchema,
  estPrefixTokens,
  type FileOverlayPart,
  OVERLAY_PART_RULES,
  type OverlayPart,
  overlayPartSchema,
  PREFIX_ERROR,
  type PrefixOverlayDetailView,
  type PrefixOverlayPullRequestResult,
  type PrefixOverlayView,
  skillOfPart,
} from '@nautelle/shared';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import type { PrefixOverlay, User } from '@prisma/client';
import { AttachmentsService } from '../attachments/attachments.service';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { BoardService } from '../board/board.service';
import { PrismaService } from '../database/prisma.service';
import { PrefixProposer } from './prefix-proposer';
import { renderedRules } from './rules-compress-input';

/** An admin acting on overlays; `role` goes with the card's runner commands. */
export interface PrefixActor {
  userId: string;
  ctx: AuditContext;
}

type OverlayRow = PrefixOverlay & {
  decidedBy: Pick<User, 'id' | 'name'> | null;
};

const prefixError = (status: number, error: string, message: string) =>
  new HttpException({ statusCode: status, error, message }, status);

export const overlayNotFound = () =>
  prefixError(404, PREFIX_ERROR.notFound, 'Overlay not found');

const view = (row: OverlayRow): PrefixOverlayView => ({
  id: row.id,
  part: overlayPartSchema.parse(row.part),
  state: row.state,
  originalSha256: row.originalSha256,
  originalBytes: row.originalBytes,
  contentBytes: row.contentBytes,
  originalEstTokens: estPrefixTokens(row.originalBytes),
  contentEstTokens: estPrefixTokens(row.contentBytes),
  rulesVersion: row.rulesVersion,
  decidedBy: row.decidedBy,
  decidedAt: row.decidedAt?.toISOString() ?? null,
  pullRequestCardId: row.pullRequestCardId,
  createdAt: row.createdAt.toISOString(),
});

/** The text of an overlay's `content` the diff shows — `rules` is rendered. */
const shownContent = (row: PrefixOverlay): string => {
  if (row.part !== OVERLAY_PART_RULES) return row.content;
  try {
    const parsed = compressedRulesSchema.safeParse(JSON.parse(row.content));
    return parsed.success ? renderedRules(parsed.data.rules) : row.content;
  } catch {
    return row.content;
  }
};

/** B12: the repository file an approved overlay replaces. */
const fileOfPart = (part: FileOverlayPart): string => {
  const skill = skillOfPart(part);
  return skill === null ? 'CLAUDE.md' : `.claude/skills/${skill}/SKILL.md`;
};

const DECIDED_BY = { decidedBy: { select: { id: true, name: true } } } as const;

/**
 * Prefix overlays (#751 B7–B13, ADR-0075). Viewers read the metadata; a
 * project admin reads the content, proposes, approves, rejects and opens the
 * pull-request card. An overlay of another project is not found. Only a
 * `proposed` overlay is decided; approving one makes it the part's open
 * overlay, used in the `prefix-overlays` B arm (B9).
 */
@Injectable()
export class PrefixOverlaysService {
  private readonly logger = new Logger(PrefixOverlaysService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly proposer: PrefixProposer,
    private readonly board: BoardService,
    private readonly attachments: AttachmentsService,
    private readonly audit: AuditService,
  ) {}

  async list(projectId: string): Promise<PrefixOverlayView[]> {
    const rows = await this.prisma.prefixOverlay.findMany({
      where: { projectId },
      orderBy: [{ createdAt: 'desc' }],
      include: DECIDED_BY,
    });
    return rows.map(view);
  }

  async detail(
    projectId: string,
    id: string,
  ): Promise<PrefixOverlayDetailView> {
    const row = await this.find(projectId, id);
    return {
      ...view(row),
      originalText: row.originalText,
      content: shownContent(row),
    };
  }

  /** B8: an admin's **Propose**; refused while the part has an open overlay. */
  async propose(
    projectId: string,
    part: FileOverlayPart,
    actor: PrefixActor,
  ): Promise<{ queued: boolean }> {
    const open = await this.prisma.prefixOverlay.findFirst({
      where: { projectId, part, state: { in: ['proposed', 'approved'] } },
      select: { id: true },
    });
    if (open) {
      throw prefixError(
        409,
        PREFIX_ERROR.openProposal,
        `${part} already has an open overlay`,
      );
    }
    if (!this.proposer.enabled) {
      throw prefixError(
        503,
        PREFIX_ERROR.runnerUnavailable,
        'Proposals need the job queue, which this instance does not run',
      );
    }
    this.proposer.request(projectId, part, actor.userId);
    await this.record(projectId, actor, 'proposed', part, null);
    return { queued: true };
  }

  async approve(
    projectId: string,
    id: string,
    actor: PrefixActor,
  ): Promise<PrefixOverlayView> {
    return this.decide(projectId, id, 'approved', actor);
  }

  async reject(
    projectId: string,
    id: string,
    actor: PrefixActor,
  ): Promise<PrefixOverlayView> {
    return this.decide(projectId, id, 'rejected', actor);
  }

  /**
   * B12: one Board card whose body says to replace the file with the attached
   * overlay verbatim; the overlay is the card's attachment (#309). A second
   * call returns the card the first made. No runner command runs here.
   */
  async pullRequest(
    projectId: string,
    id: string,
    actor: PrefixActor,
  ): Promise<PrefixOverlayPullRequestResult> {
    const row = await this.find(projectId, id);
    if (row.state !== 'approved' || row.part === OVERLAY_PART_RULES) {
      throw prefixError(
        409,
        PREFIX_ERROR.notPullable,
        'Only an approved overlay of a repository file opens a pull request',
      );
    }
    const part = row.part as FileOverlayPart;
    if (row.pullRequestCardId !== null) {
      const card = await this.prisma.boardCard.findUnique({
        where: { id: row.pullRequestCardId },
        select: { id: true, number: true },
      });
      if (card) return { cardId: card.id, number: card.number };
    }
    const file = fileOfPart(part);
    const boardActor = {
      userId: actor.userId,
      role: 'admin' as const,
      ctx: actor.ctx,
    };
    const attachment = await this.attachments.uploadBytes(
      projectId,
      file.split('/').at(-1) ?? 'overlay.md',
      new TextEncoder().encode(row.content),
      boardActor,
    );
    const card = await this.board.create(
      projectId,
      {
        title: `Replace ${file} with its approved overlay`,
        body: [
          `Replace \`${file}\` in the repository with the attached file, verbatim — byte for byte, nothing else changed.`,
          '',
          `It is the prefix overlay a project admin approved in Nautelle: ${row.originalBytes} → ${row.contentBytes} bytes (≈${estPrefixTokens(row.originalBytes)} → ≈${estPrefixTokens(row.contentBytes)} tokens). If the file in the repository no longer matches the original it was made from, stop and say so instead.`,
        ].join('\n'),
        kind: 'feature',
        issueOnRun: false,
        attachmentIds: [attachment.id],
      },
      boardActor,
    );
    await this.prisma.prefixOverlay.update({
      where: { id: row.id },
      data: { pullRequestCardId: card.id },
    });
    await this.record(projectId, actor, 'pull_request', part, row.id, {
      card: card.number,
    });
    return { cardId: card.id, number: card.number };
  }

  /**
   * B10: the runner found the original changed. An open overlay of the
   * project becomes `stale` and a new proposal is queued; anything else — an
   * unknown id, another project's, a matching hash — changes nothing.
   */
  async markStale(
    projectId: string,
    overlayId: string,
    sha256: string,
  ): Promise<boolean> {
    const row = await this.prisma.prefixOverlay.findFirst({
      where: { id: overlayId, projectId },
      select: { id: true, part: true, state: true, originalSha256: true },
    });
    if (
      !row ||
      row.part === OVERLAY_PART_RULES ||
      row.originalSha256 === sha256 ||
      (row.state !== 'approved' && row.state !== 'proposed')
    ) {
      return false;
    }
    const updated = await this.prisma.prefixOverlay.updateMany({
      where: { id: row.id, state: row.state },
      data: { state: 'stale' },
    });
    if (updated.count === 0) return false;
    this.logger.log(`overlay ${row.id} (${row.part}) is stale`);
    this.proposer.request(projectId, row.part as FileOverlayPart);
    return true;
  }

  private async decide(
    projectId: string,
    id: string,
    state: 'approved' | 'rejected',
    actor: PrefixActor,
  ): Promise<PrefixOverlayView> {
    const row = await this.find(projectId, id);
    const updated = await this.prisma.prefixOverlay.updateMany({
      where: { id: row.id, state: 'proposed' },
      data: { state, decidedById: actor.userId, decidedAt: new Date() },
    });
    if (updated.count === 0) {
      throw prefixError(
        409,
        PREFIX_ERROR.notProposed,
        'Only a proposed overlay is approved or rejected',
      );
    }
    await this.record(
      projectId,
      actor,
      state,
      row.part as OverlayPart,
      row.id,
      {
        originalBytes: row.originalBytes,
        contentBytes: row.contentBytes,
      },
    );
    return view(await this.find(projectId, id));
  }

  private async find(projectId: string, id: string): Promise<OverlayRow> {
    const row = await this.prisma.prefixOverlay.findFirst({
      where: { id, projectId },
      include: DECIDED_BY,
    });
    if (!row) throw overlayNotFound();
    return row;
  }

  private record(
    projectId: string,
    actor: PrefixActor,
    change: 'proposed' | 'approved' | 'rejected' | 'pull_request',
    part: OverlayPart,
    overlayId: string | null,
    meta: object = {},
  ): Promise<void> {
    return this.audit.record({
      ...actor.ctx,
      action: 'project.prefix_overlay',
      target: { type: 'project', id: projectId },
      projectId,
      result: 'ok',
      meta: { change, part, overlayId, ...meta },
    });
  }
}
