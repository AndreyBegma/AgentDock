import type {
  AssistantConversationView,
  AssistantMessageView,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-request';
import { PrismaService } from '../database/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { AssistantAttachments } from './assistant-attachments.service';
import { assistantError, conversationNotFound } from './assistant-error';
import {
  ATTACHMENT_INCLUDE,
  type ConversationRow,
  toConversationView,
  toMessageView,
} from './assistant-mapper';
import { AssistantModels } from './assistant-models';
import type {
  CreateAssistantConversationDto,
  UpdateAssistantConversationDto,
} from './dto';

const PROJECT = { project: { select: { displayName: true } } } as const;

/**
 * ADR-0060 §1: a conversation is personal. Every read and write is scoped to
 * its owner; anyone else's id is 404, the same as one that does not exist.
 */
@Injectable()
export class AssistantConversations {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
    private readonly models: AssistantModels,
    private readonly attachments: AssistantAttachments,
  ) {}

  /** The owner's conversation; 404 for anyone else's. */
  async owned(
    user: Pick<AuthUser, 'id'>,
    id: string,
  ): Promise<ConversationRow> {
    const row = await this.prisma.assistantConversation.findFirst({
      where: { id, userId: user.id },
      include: PROJECT,
    });
    if (!row) throw conversationNotFound();
    return row;
  }

  async list(user: AuthUser): Promise<AssistantConversationView[]> {
    const rows = await this.prisma.assistantConversation.findMany({
      where: { userId: user.id },
      include: PROJECT,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 200,
    });
    return rows.map(toConversationView);
  }

  async get(user: AuthUser, id: string): Promise<AssistantConversationView> {
    return toConversationView(await this.owned(user, id));
  }

  async create(
    user: AuthUser,
    dto: CreateAssistantConversationDto,
  ): Promise<AssistantConversationView> {
    if (dto.projectId) await this.assertVisible(user, dto.projectId);
    if (dto.provider && dto.model) {
      await this.models.assertEnabled({
        provider: dto.provider,
        model: dto.model,
      });
    }
    const row = await this.prisma.assistantConversation.create({
      data: {
        userId: user.id,
        projectId: dto.projectId ?? null,
        provider: dto.provider ?? null,
        model: dto.model ?? null,
      },
      include: PROJECT,
    });
    return toConversationView(row);
  }

  async update(
    user: AuthUser,
    id: string,
    dto: UpdateAssistantConversationDto,
  ): Promise<AssistantConversationView> {
    await this.owned(user, id);
    if (dto.projectId) await this.assertVisible(user, dto.projectId);
    const modelChange = dto.provider !== undefined || dto.model !== undefined;
    if (modelChange && dto.provider && dto.model) {
      await this.models.assertEnabled({
        provider: dto.provider,
        model: dto.model,
      });
    }
    const row = await this.prisma.assistantConversation.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.projectId !== undefined ? { projectId: dto.projectId } : {}),
        ...(modelChange
          ? { provider: dto.provider ?? null, model: dto.model ?? null }
          : {}),
      },
      include: PROJECT,
    });
    return toConversationView(row);
  }

  async remove(user: AuthUser, id: string): Promise<void> {
    await this.owned(user, id);
    await this.attachments.removeFilesOf(id);
    await this.prisma.assistantConversation.delete({ where: { id } });
  }

  /** Oldest first; each message with what was sent with it. */
  async messages(user: AuthUser, id: string): Promise<AssistantMessageView[]> {
    await this.owned(user, id);
    const rows = await this.prisma.assistantMessage.findMany({
      where: { conversationId: id },
      include: { attachments: { include: ATTACHMENT_INCLUDE } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toMessageView);
  }

  private async assertVisible(user: AuthUser, projectId: string) {
    if (!(await this.access.resolve(user, projectId))) {
      throw assistantError(404, 'not_found', 'Project not found');
    }
  }
}
