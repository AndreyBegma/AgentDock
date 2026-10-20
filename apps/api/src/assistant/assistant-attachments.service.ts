import {
  ASSISTANT_ATTACHMENTS_MAX,
  type AssistantAttachmentView,
  BOARD_CARD_BODY_MAX,
  projectRoleAtLeast,
  type Role,
} from '@nautelle/shared';
import { Injectable } from '@nestjs/common';
import { AttachmentStore } from '../attachments/attachment-store';
import {
  type AttachmentActor,
  AttachmentsService,
  type UploadedAttachment,
} from '../attachments/attachments.service';
import type { AuditContext } from '../audit/audit.types';
import type { AuthUser } from '../auth/auth-request';
import { PrismaService } from '../database/prisma.service';
import type { LlmContentPart, LlmImageMediaType } from '../llm/types';
import { ProjectAccessService } from '../projects/project-access.service';
import { assistantError } from './assistant-error';
import {
  ATTACHMENT_INCLUDE,
  type AttachmentRow,
  toAttachmentView,
} from './assistant-mapper';
import type { AddAssistantAttachmentDto } from './dto';

/** Characters of one attachment's text sent to the model. */
const ATTACHMENT_TEXT_MAX = 24_000;
/** Newest session content items sent for an attached session. */
const SESSION_ITEMS = 60;
/** Bytes of an image sent to the model (providers cap near 5 MB). */
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const IMAGE_TYPES: readonly LlmImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

const clip = (text: string, max = ATTACHMENT_TEXT_MAX): string =>
  text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text;

const contentOff = () =>
  assistantError(
    409,
    'session_content_off',
    "The session's project keeps session content on the machine (ADR-0021): it cannot be attached",
  );

const readAll = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
};

/**
 * ADR-0060 §5: what a person attaches to a conversation — a Board card, an
 * agent session of a project that ships content (ADR-0021), or a file stored
 * as a Board attachment is (ADR-0031). Each is checked when attached and
 * again when it is sent, so access lost since is never read.
 */
@Injectable()
export class AssistantAttachments {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
    private readonly files: AttachmentsService,
    private readonly store: AttachmentStore,
  ) {}

  async list(conversationId: string): Promise<AssistantAttachmentView[]> {
    const rows = await this.prisma.assistantAttachment.findMany({
      where: { conversationId },
      include: ATTACHMENT_INCLUDE,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toAttachmentView);
  }

  async add(
    user: AuthUser,
    conversationId: string,
    dto: AddAssistantAttachmentDto,
  ): Promise<AssistantAttachmentView> {
    await this.assertRoom(conversationId);
    if (dto.kind === 'card') {
      const projectId = dto.projectId as string;
      await this.role(user, projectId, 'viewer');
      const card = await this.prisma.boardCard.findUnique({
        where: {
          projectId_number: { projectId, number: dto.cardNumber as number },
        },
        select: { id: true, number: true, title: true },
      });
      if (!card) throw assistantError(404, 'not_found', 'Card not found');
      return this.create({
        conversationId,
        kind: 'card',
        cardId: card.id,
        label: `C-${card.number} ${card.title}`.slice(0, 200),
      });
    }
    const session = await this.sessionOf(user, dto.sessionId as string);
    return this.create({
      conversationId,
      kind: 'session',
      sessionId: session.id,
      label: (session.title ?? session.slotName ?? 'Session').slice(0, 200),
    });
  }

  /** ADR-0031: stored on the conversation's project, as a Board upload is. */
  addFile(
    user: AuthUser,
    conversation: { id: string; projectId: string | null },
    file: UploadedAttachment | undefined,
    ctx: AuditContext,
  ): Promise<AssistantAttachmentView> {
    return this.claim(user, conversation, ctx, (projectId, actor) =>
      this.files.upload(projectId, file, actor),
    );
  }

  /** #620: a file that arrived as bytes — a Telegram photo — stored the same way. */
  addBytes(
    user: AuthUser,
    conversation: { id: string; projectId: string | null },
    name: string,
    bytes: Uint8Array,
    ctx: AuditContext,
  ): Promise<AssistantAttachmentView> {
    return this.claim(user, conversation, ctx, (projectId, actor) =>
      this.files.uploadBytes(projectId, name, bytes, actor),
    );
  }

  async remove(conversationId: string, id: string): Promise<void> {
    const row = await this.prisma.assistantAttachment.findFirst({
      where: { id, conversationId },
      include: ATTACHMENT_INCLUDE,
    });
    if (!row) throw assistantError(404, 'not_found', 'Attachment not found');
    await this.prisma.assistantAttachment.delete({ where: { id } });
    if (row.attachmentId && row.attachment) {
      await this.dropFile(row.attachment.projectId, row.attachmentId);
    }
  }

  /** Before a conversation is deleted: its stored files go with it. */
  async removeFilesOf(conversationId: string): Promise<void> {
    const rows = await this.prisma.assistantAttachment.findMany({
      where: { conversationId, kind: 'file' },
      include: ATTACHMENT_INCLUDE,
    });
    for (const row of rows) {
      if (row.attachmentId && row.attachment) {
        await this.dropFile(row.attachment.projectId, row.attachmentId);
      }
    }
  }

  /** The pending attachments, which the message being sent takes. */
  pending(conversationId: string): Promise<AttachmentRow[]> {
    return this.prisma.assistantAttachment.findMany({
      where: { conversationId, messageId: null },
      include: ATTACHMENT_INCLUDE,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * The model input of a message's attachments: cards and sessions as text,
   * text files as text, images as images for a model that sees them.
   */
  async contentOf(
    user: AuthUser,
    rows: readonly AttachmentRow[],
    vision: boolean,
  ): Promise<LlmContentPart[]> {
    const parts: LlmContentPart[] = [];
    for (const row of rows) {
      try {
        parts.push(...(await this.partsOf(user, row, vision)));
      } catch {
        parts.push({
          type: 'text',
          text: `[Attachment "${row.label}" is no longer available to this person]`,
        });
      }
    }
    return parts;
  }

  private async partsOf(
    user: AuthUser,
    row: AttachmentRow,
    vision: boolean,
  ): Promise<LlmContentPart[]> {
    if (row.kind === 'card' && row.cardId && row.card) {
      await this.role(user, row.card.projectId, 'viewer');
      const card = await this.prisma.boardCard.findUniqueOrThrow({
        where: { id: row.cardId },
        select: { number: true, title: true, body: true, column: true },
      });
      return [
        {
          type: 'text',
          text: `[Attached card C-${card.number} "${card.title}", column ${card.column}]\n${clip(card.body, BOARD_CARD_BODY_MAX)}`,
        },
      ];
    }
    if (row.kind === 'session' && row.sessionId) {
      const session = await this.sessionOf(user, row.sessionId);
      const items = await this.prisma.sessionContent.findMany({
        where: { sessionId: session.id, projectId: session.projectId },
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        take: SESSION_ITEMS,
      });
      const lines = items
        .reverse()
        .map(
          (i) =>
            `${i.kind}${i.toolName ? ` ${i.toolName}` : ''}: ${i.text ?? ''}`,
        );
      return [
        {
          type: 'text',
          text: `[Attached session "${row.label}", its latest ${lines.length} items]\n${clip(lines.join('\n'))}`,
        },
      ];
    }
    if (row.kind === 'file' && row.attachmentId && row.attachment) {
      const { projectId, mime, size } = row.attachment;
      await this.role(user, projectId, 'viewer');
      const image = IMAGE_TYPES.find((t) => t === mime);
      if (image) {
        if (!vision || size > IMAGE_MAX_BYTES) {
          return [
            {
              type: 'text',
              text: `[Attached image "${row.label}": not sent, ${vision ? 'it is too large' : 'this model does not take images'}]`,
            },
          ];
        }
        const bytes = await readAll(
          await this.store.open(projectId, row.attachmentId),
        );
        return [
          { type: 'text', text: `[Attached image "${row.label}"]` },
          { type: 'image', mediaType: image, data: bytes.toString('base64') },
        ];
      }
      if (mime.startsWith('text/') || mime === 'application/json') {
        const bytes = await readAll(
          await this.store.open(projectId, row.attachmentId),
        );
        return [
          {
            type: 'text',
            text: `[Attached file "${row.label}"]\n${clip(bytes.toString('utf8'))}`,
          },
        ];
      }
      return [
        {
          type: 'text',
          text: `[Attached file "${row.label}" (${mime}): its content is not sent to the model]`,
        },
      ];
    }
    return [];
  }

  /** A session the person can read whose project ships content (ADR-0021). */
  private async sessionOf(user: AuthUser, sessionId: string) {
    const session = await this.prisma.agentSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        title: true,
        slotName: true,
        projectId: true,
        project: { select: { shipSessionContent: true } },
      },
    });
    if (!session?.projectId || !session.project) {
      // No project: admins see it, but it never ships content (ADR-0021 §3).
      if (session && user.role === 'admin') throw contentOff();
      throw assistantError(404, 'not_found', 'Session not found');
    }
    await this.role(user, session.projectId, 'viewer', 'Session not found');
    if (!session.project.shipSessionContent) throw contentOff();
    return { ...session, projectId: session.projectId };
  }

  /** The person's role on the project, at least `need`. */
  private async role(
    user: AuthUser,
    projectId: string,
    need: Role,
    notFound = 'Project not found',
  ): Promise<Role> {
    const access = await this.access.resolve(user, projectId);
    if (!access) throw assistantError(404, 'not_found', notFound);
    if (!projectRoleAtLeast(access.role, need)) {
      throw assistantError(403, 'forbidden', `This needs ${need} or higher`);
    }
    return access.role;
  }

  private async assertRoom(conversationId: string): Promise<void> {
    const count = await this.prisma.assistantAttachment.count({
      where: { conversationId },
    });
    if (count >= ASSISTANT_ATTACHMENTS_MAX) {
      throw assistantError(
        409,
        'too_many_attachments',
        `A conversation holds at most ${ASSISTANT_ATTACHMENTS_MAX} attachments`,
      );
    }
  }

  private async create(data: {
    conversationId: string;
    kind: 'card' | 'session' | 'file';
    cardId?: string;
    sessionId?: string;
    attachmentId?: string;
    label: string;
  }): Promise<AssistantAttachmentView> {
    const row = await this.prisma.assistantAttachment.create({
      data,
      include: ATTACHMENT_INCLUDE,
    });
    return toAttachmentView(row);
  }

  private async claim(
    user: AuthUser,
    conversation: { id: string; projectId: string | null },
    ctx: AuditContext,
    upload: (
      projectId: string,
      actor: AttachmentActor,
    ) => Promise<{ id: string; name: string }>,
  ): Promise<AssistantAttachmentView> {
    if (!conversation.projectId) {
      throw assistantError(
        409,
        'project_required',
        "A file is stored against a project's attachment quota: pick the conversation's project first",
      );
    }
    await this.assertRoom(conversation.id);
    const role = await this.role(user, conversation.projectId, 'operator');
    const stored = await upload(conversation.projectId, {
      userId: user.id,
      role,
      ctx,
    });
    // Claimed by the assistant: the pending-upload sweep leaves it alone.
    await this.prisma.attachment.update({
      where: { id: stored.id },
      data: { expiresAt: null },
    });
    return this.create({
      conversationId: conversation.id,
      kind: 'file',
      attachmentId: stored.id,
      label: stored.name,
    });
  }

  private async dropFile(projectId: string, id: string): Promise<void> {
    await this.prisma.attachment.deleteMany({ where: { id } });
    await this.files.removeFiles(projectId, [id]);
  }
}
