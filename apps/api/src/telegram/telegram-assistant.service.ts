import {
  ASSISTANT_MESSAGE_MAX,
  type AssistantMessageView,
  ATTACHMENT_MAX_BYTES,
} from '@agentdock/shared';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import { streamError } from '../assistant/assistant.controller';
import { AssistantAttachments } from '../assistant/assistant-attachments.service';
import { AssistantChat } from '../assistant/assistant-chat.service';
import { AssistantConversations } from '../assistant/assistant-conversations.service';
import { type AuditContext, userActor } from '../audit/audit.types';
import type { AuthUser } from '../auth/auth-request';
import { PrismaService } from '../database/prisma.service';
import { actionRequestLink } from '../local/action-request-mapper';
import { httpErrorBody } from '../local/local-error';
import { BotTokenStore } from '../notifications';
import {
  ASSISTANT_REPLIES,
  assistantReplyParts,
  turnErrorText,
} from './assistant-reply';
import {
  type IntakeMedia,
  intakeMediaOf,
  MEDIA_REPLIES,
  notStoredText,
} from './intake-media';
import { TelegramActionRequestService } from './telegram-action-request.service';
import {
  FileTooLargeError,
  type InlineKeyboard,
  TelegramApiError,
  TelegramClient,
  type TelegramMessage,
  type TelegramReplyMarkup,
} from './telegram-client';
import { TelegramGuard } from './telegram-guard.service';
import { LINK_REPLIES } from './telegram-linking.service';
import {
  projectRefusalText,
  TelegramProjectService,
} from './telegram-project.service';
import {
  type CommandContext,
  parseCommand,
  type TelegramAnswer,
} from './telegram-router';

/** Telegram shows "typing…" for five seconds; it is sent again before that. */
const TYPING_EVERY_MS = 4_000;

type Image = Extract<IntakeMedia, { kind: 'image' }>;

/**
 * #620 (ADR-0061): free text in a linked private chat goes to the assistant
 * (ADR-0060) as the chat's linked user — the same turn the web runs, so the
 * gateway's caps and the tools' role checks apply as they do there. A chat
 * continues one conversation, kept on its link, until `/newchat`; a new one
 * starts on the chat's current project, else on Auto. The reply is one
 * MarkdownV2 message, split when it is too long, after a typing indicator;
 * an action the turn requested comes with the Approve / Deny buttons of its
 * `action.requested` notification. A turn runs beside the poller, one per
 * chat at a time, so a slow model never holds up anyone's buttons.
 */
@Injectable()
export class TelegramAssistantService {
  private readonly logger = new Logger(TelegramAssistantService.name);
  /** The turn each chat is waiting on. */
  private readonly running = new Map<number, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly guard: TelegramGuard,
    private readonly projects: TelegramProjectService,
    private readonly conversations: AssistantConversations,
    private readonly attachments: AssistantAttachments,
    private readonly chat: AssistantChat,
    private readonly actionRequests: TelegramActionRequestService,
    private readonly client: TelegramClient,
    private readonly tokens: BotTokenStore,
  ) {}

  /** `/newchat`: the chat's next message starts a new conversation. */
  async handleNewChat(context: CommandContext): Promise<TelegramAnswer> {
    const { chatId } = context;
    if (!context.isPrivate) return { chatId, text: LINK_REPLIES.notPrivate };
    const linked = await this.guard.linkedUser(chatId);
    if (!linked.ok) {
      return { chatId, text: projectRefusalText(linked.reason) };
    }
    await this.prisma.telegramLink.update({
      where: { userId: linked.user.id },
      data: { assistantConversationId: null },
    });
    return { chatId, text: ASSISTANT_REPLIES.newChat };
  }

  /**
   * A message no reply handler took and no command: text, or a photo with a
   * caption. Nothing for a group, an unlinked chat, or other media. The turn
   * answers on its own; the poller gets an answer only for a refusal.
   */
  async handleMessage(
    message: TelegramMessage,
  ): Promise<TelegramAnswer | null> {
    const chatId = message.chat.id;
    if (message.chat.type !== 'private') return null;
    const media = intakeMediaOf(message);
    if (media && media.kind !== 'image') return null;
    const text = (media ? message.caption : message.text)?.trim() ?? '';
    // A caption that is a command belongs to no one here.
    if (parseCommand(text)) return null;
    const linked = await this.guard.linkedUser(chatId);
    if (!linked.ok) {
      return linked.reason === 'not_linked'
        ? null
        : { chatId, text: projectRefusalText(linked.reason) };
    }
    if (!text) {
      return media
        ? { chatId, text: ASSISTANT_REPLIES.photoNeedsCaption }
        : null;
    }
    if (text.length > ASSISTANT_MESSAGE_MAX) {
      return { chatId, text: ASSISTANT_REPLIES.tooLong };
    }
    if (this.running.has(chatId))
      return { chatId, text: ASSISTANT_REPLIES.busy };
    const turn = this.answer(chatId, linked.user.id, text, media)
      .catch((error: unknown) => {
        this.logger.warn(
          `assistant reply to a Telegram chat failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => this.running.delete(chatId));
    this.running.set(chatId, turn);
    return null;
  }

  /** Resolves once every turn running now has answered; for tests and shutdown. */
  async idle(): Promise<void> {
    await Promise.all([...this.running.values()]);
  }

  private async answer(
    chatId: number,
    userId: string,
    text: string,
    media: Image | null,
  ): Promise<void> {
    const bot = await this.tokens.read();
    if (!bot.ok) return;
    const { token } = bot;
    const typing = () =>
      this.client.sendChatAction(token, chatId).catch(() => undefined);
    void typing();
    const timer = setInterval(() => void typing(), TYPING_EVERY_MS);
    try {
      const outcome = await this.turn(chatId, userId, text, media, token);
      if (outcome.kind === 'refused') {
        await this.client.sendMessage(token, chatId, outcome.text, true);
        return;
      }
      clearInterval(timer);
      await this.send(token, chatId, outcome.reply, outcome.markup);
    } finally {
      clearInterval(timer);
    }
  }

  private async turn(
    chatId: number,
    userId: string,
    text: string,
    media: Image | null,
    token: string,
  ): Promise<
    | { kind: 'refused'; text: string }
    | { kind: 'reply'; reply: string; markup?: TelegramReplyMarkup }
  > {
    const user = await this.authUser(userId);
    if (!user)
      return { kind: 'refused', text: projectRefusalText('inactive_user') };
    const ctx: AuditContext = { actor: userActor(userId) };
    const conversation = await this.conversationOf(chatId, user);
    if (media) {
      const refusal = await this.attach(user, conversation, media, ctx, token);
      if (refusal) return { kind: 'refused', text: refusal };
    }
    const started = new Date();
    let reply: AssistantMessageView | null = null;
    try {
      for await (const event of this.chat.turn({
        user,
        ctx,
        conversationId: conversation.id,
        message: text,
      })) {
        if (event.type === 'done') reply = event.message;
      }
    } catch (error) {
      const failed = streamError(error);
      if (failed.code === 'assistant_failed') {
        this.logger.error(
          `assistant turn of ${conversation.id} from Telegram failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { kind: 'refused', text: turnErrorText(failed) };
    }
    const markup = await this.approvalButtons(userId, started);
    return {
      kind: 'reply',
      reply: reply?.displayContent ?? '',
      ...(markup ? { markup } : {}),
    };
  }

  /** Each part as MarkdownV2, plain if Telegram refuses its markup; buttons on the last. */
  private async send(
    token: string,
    chatId: number,
    reply: string,
    markup: TelegramReplyMarkup | undefined,
  ): Promise<void> {
    const parts = assistantReplyParts(reply);
    if (parts.length === 0) {
      await this.client.sendMessage(
        token,
        chatId,
        ASSISTANT_REPLIES.empty,
        true,
        markup,
      );
      return;
    }
    for (const [index, part] of parts.entries()) {
      const buttons = index === parts.length - 1 ? markup : undefined;
      try {
        await this.client.sendMessage(token, chatId, part.text, false, buttons);
      } catch (error) {
        if (!(error instanceof TelegramApiError) || error.status !== 400) {
          throw error;
        }
        await this.client.sendMessage(token, chatId, part.plain, true, buttons);
      }
    }
  }

  /**
   * The conversation the chat continues: the link's, while it is still the
   * user's; else a new one on the chat's current project, recorded on the
   * link. One still on Auto takes the current project once there is one.
   */
  private async conversationOf(
    chatId: number,
    user: AuthUser,
  ): Promise<{ id: string; projectId: string | null }> {
    const link = await this.prisma.telegramLink.findUnique({
      where: { userId: user.id },
      select: { assistantConversationId: true },
    });
    const current = await this.projects.current(chatId, 'read');
    const projectId = current.ok ? current.project.id : null;
    const kept = link?.assistantConversationId
      ? await this.prisma.assistantConversation.findFirst({
          where: { id: link.assistantConversationId, userId: user.id },
          select: { id: true, projectId: true },
        })
      : null;
    if (kept) {
      if (kept.projectId || !projectId) return kept;
      await this.conversations.update(user, kept.id, { projectId });
      return { id: kept.id, projectId };
    }
    const created = await this.conversations.create(user, { projectId });
    await this.prisma.telegramLink.update({
      where: { userId: user.id },
      data: { assistantConversationId: created.id },
    });
    return { id: created.id, projectId: created.projectId };
  }

  /** The photo, stored as a file of the conversation; a refusal's text, or null. */
  private async attach(
    user: AuthUser,
    conversation: { id: string; projectId: string | null },
    media: Image,
    ctx: AuditContext,
    token: string,
  ): Promise<string | null> {
    if (!conversation.projectId) return ASSISTANT_REPLIES.photoNeedsProject;
    if (media.size !== null && media.size > ATTACHMENT_MAX_BYTES) {
      return MEDIA_REPLIES.tooLarge;
    }
    let bytes: Uint8Array;
    try {
      const file = await this.client.getFile(token, media.fileId);
      if (file.size !== null && file.size > ATTACHMENT_MAX_BYTES) {
        return MEDIA_REPLIES.tooLarge;
      }
      bytes = await this.client.downloadFile(
        token,
        file.path,
        ATTACHMENT_MAX_BYTES,
      );
    } catch (error) {
      if (error instanceof FileTooLargeError) return MEDIA_REPLIES.tooLarge;
      if (!(error instanceof TelegramApiError)) throw error;
      if (/too big/i.test(error.message)) return MEDIA_REPLIES.tooLarge;
      this.logger.warn(`photo not downloaded: ${error.message}`);
      return MEDIA_REPLIES.downloadFailed;
    }
    try {
      await this.attachments.addBytes(
        user,
        conversation,
        media.name,
        bytes,
        ctx,
      );
      return null;
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      return notStoredText(httpErrorBody(error).message);
    }
  }

  /**
   * ADR-0061 §4: the Approve / Deny buttons of each action this turn
   * requested, as its `action.requested` notification to the user carries
   * them — the same callback, checked the same way when pressed.
   */
  private async approvalButtons(
    userId: string,
    since: Date,
  ): Promise<TelegramReplyMarkup | null> {
    const requests = await this.prisma.actionRequest.findMany({
      where: {
        requestedById: userId,
        status: 'pending',
        createdAt: { gte: since },
      },
      select: { id: true, projectId: true },
      orderBy: { createdAt: 'asc' },
    });
    const rows: InlineKeyboard = [];
    for (const request of requests) {
      const notification = await this.prisma.notification.findFirst({
        where: {
          userId,
          kind: 'action.requested',
          link: actionRequestLink(request.projectId, request.id),
        },
        select: { id: true },
      });
      if (!notification) continue;
      const offer = await this.actionRequests.offer(notification.id);
      if (offer && 'inline_keyboard' in offer)
        rows.push(...offer.inline_keyboard);
    }
    return rows.length > 0 ? { inline_keyboard: rows } : null;
  }

  private async authUser(userId: string): Promise<AuthUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, role: true, status: true },
    });
    return user?.status === 'active' ? user : null;
  }
}
