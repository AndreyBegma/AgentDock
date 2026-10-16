import {
  CARD_WAITING_EVENT,
  isActiveRoundPhase,
  type PendingQuestion,
  type SessionMessageInput,
} from '@agentdock/shared';
import { roleAtLeast } from '@agentdock/shared/protocol';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit';
import { ANONYMOUS_ACTOR, userActor } from '../audit/audit.types';
import { pendingQuestionOf } from '../board/board-mapper';
import { BoardSessionMessages } from '../board/board-session-message.service';
import type { BoardActor } from '../board/board-work';
import { PrismaService } from '../database/prisma.service';
import { httpErrorBody } from '../local/local-error';
import { ProjectAccessService } from '../projects';
import {
  decodeSessionOptionCallback,
  parseSessionReference,
  questionKeyboard,
  type SessionRefusal,
  sessionErrorText,
  sessionOutcomeText,
  sessionRefusalText,
  sessionReplyFooter,
} from './session-message-actions';
import type { ApprovalAnswer } from './telegram-approval.service';
import type {
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramReplyMarkup,
} from './telegram-client';

const KIND = 'card.waiting';

/** What a `card.waiting` message goes out with (#489 M2). */
export interface SessionOffer {
  /** MarkdownV2 lines added under the message. */
  footer: string;
  replyMarkup?: TelegramReplyMarkup;
}

interface WaitingCard {
  projectId: string;
  number: number;
  question: PendingQuestion | null;
}

type Authorized =
  | { ok: true; actor: BoardActor; card: WaitingCard }
  | {
      ok: false;
      reason: SessionRefusal;
      userId: string | null;
      projectId: string | null;
    };

/**
 * #489 M2: a `card.waiting` message on Telegram carries the question's
 * options as buttons and takes a reply as text for the session. As with
 * the PR and action-request buttons, every press and reply is checked from
 * scratch: a private chat linked to an AgentDock user with the one-time
 * code (`/start <code>`), a message sent to that user for this card, an
 * active user who is an operator of the project now. It is then sent as
 * `session.message` through `BoardSessionMessages`, which audits it
 * (`card.message`, `via: telegram`); a refusal before that is audited here.
 */
@Injectable()
export class TelegramSessionMessageService {
  private readonly logger = new Logger(TelegramSessionMessageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly messages: BoardSessionMessages,
    private readonly access: ProjectAccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The footer and buttons of notification `notificationId`; null when it
   * is not a `card.waiting` one or its card has no running round. Never
   * throws: a delivery does not fail for them.
   */
  async offer(notificationId: bigint): Promise<SessionOffer | null> {
    try {
      const notification = await this.prisma.notification.findUnique({
        where: { id: notificationId },
        select: { kind: true, projectId: true, eventId: true },
      });
      if (notification?.kind !== KIND || !notification.projectId) return null;
      const card = await this.waitingCard(
        notification.projectId,
        notification.eventId,
      );
      if (!card) return null;
      return {
        footer: sessionReplyFooter(notificationId, card.question),
        ...(card.question
          ? {
              replyMarkup: {
                inline_keyboard: questionKeyboard(
                  notificationId,
                  card.question,
                ),
              },
            }
          : {}),
      };
    } catch (error) {
      this.logger.warn(
        `no session buttons for notification ${notificationId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async handleCallback(query: TelegramCallbackQuery): Promise<ApprovalAnswer> {
    const chat = query.message?.chat;
    const chatId = chat?.id ?? query.from.id;
    const answer = (text: string): ApprovalAnswer => ({
      chatId,
      text,
      callbackQueryId: query.id,
      notice: text,
    });
    const press = decodeSessionOptionCallback(query.data);
    if (!press || (chat && chat.type !== 'private')) {
      return answer(sessionRefusalText('invalid_button'));
    }
    const authorized = await this.authorize(chatId, press.notificationId);
    if (!authorized.ok) {
      await this.recordRefusal(authorized);
      return answer(sessionRefusalText(authorized.reason));
    }
    return answer(
      await this.send(authorized, {
        kind: 'option',
        questionKey: press.questionKey,
        index: press.index,
      }),
    );
  }

  /**
   * A reply to a `card.waiting` message: text for the session — or, while
   * its question offers "Other", the typed answer. Null for a message that
   * answers none of them.
   */
  async handleReply(
    message: TelegramMessage,
    botId: number,
  ): Promise<ApprovalAnswer | null> {
    const prompt = message.reply_to_message;
    if (!prompt || prompt.from?.id !== botId) return null;
    const notificationId = parseSessionReference(prompt.text);
    if (notificationId === null) return null;
    const chatId = message.chat.id;
    if (message.chat.type !== 'private' || !message.text) {
      return { chatId, text: sessionRefusalText('invalid_button') };
    }
    const authorized = await this.authorize(chatId, notificationId);
    if (!authorized.ok) {
      await this.recordRefusal(authorized);
      return { chatId, text: sessionRefusalText(authorized.reason) };
    }
    const { question } = authorized.card;
    const input: SessionMessageInput =
      question?.other === true
        ? { kind: 'other', questionKey: question.key, text: message.text }
        : { kind: 'text', text: message.text };
    return { chatId, text: await this.send(authorized, input) };
  }

  private async send(
    authorized: Extract<Authorized, { ok: true }>,
    input: SessionMessageInput,
  ): Promise<string> {
    try {
      const { outcome } = await this.messages.message(
        authorized.card.projectId,
        authorized.card.number,
        input,
        authorized.actor,
        'telegram',
      );
      return sessionOutcomeText(outcome);
    } catch (error) {
      // The service audited it.
      if (!(error instanceof HttpException)) throw error;
      return sessionErrorText(httpErrorBody(error).code);
    }
  }

  /** The card of a `card.waiting` event while its round runs. */
  private async waitingCard(
    projectId: string,
    eventId: bigint | null,
  ): Promise<WaitingCard | null> {
    if (eventId === null) return null;
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { type: true, data: true },
    });
    const data = event?.data;
    const cardId =
      event?.type === CARD_WAITING_EVENT &&
      typeof data === 'object' &&
      data !== null &&
      !Array.isArray(data) &&
      typeof data.cardId === 'string'
        ? data.cardId
        : null;
    if (!cardId) return null;
    const card = await this.prisma.boardCard.findFirst({
      where: { id: cardId, projectId },
      select: {
        number: true,
        rounds: { orderBy: { round: 'desc' }, take: 1 },
      },
    });
    const round = card?.rounds[0];
    if (!card || !round) return null;
    if (!isActiveRoundPhase(round.phase)) {
      return null;
    }
    return {
      projectId,
      number: card.number,
      question: pendingQuestionOf(round),
    };
  }

  private async authorize(
    chatId: number,
    notificationId: bigint,
  ): Promise<Authorized> {
    const link = await this.prisma.telegramLink.findUnique({
      where: { chatId: BigInt(chatId) },
      select: { userId: true },
    });
    if (!link) {
      return { ok: false, reason: 'not_linked', userId: null, projectId: null };
    }
    const userId = link.userId;
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      select: { userId: true, kind: true, projectId: true, eventId: true },
    });
    if (
      notification?.userId !== userId ||
      notification.kind !== KIND ||
      !notification.projectId
    ) {
      return { ok: false, reason: 'unknown_message', userId, projectId: null };
    }
    const projectId = notification.projectId;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, role: true, status: true },
    });
    if (user?.status !== 'active') {
      return { ok: false, reason: 'inactive_user', userId, projectId };
    }
    const access = await this.access.resolve(user, projectId);
    if (!access) return { ok: false, reason: 'not_member', userId, projectId };
    if (!roleAtLeast(access.role, 'operator')) {
      return { ok: false, reason: 'role', userId, projectId };
    }
    const card = await this.waitingCard(projectId, notification.eventId);
    if (!card) {
      return { ok: false, reason: 'unknown_message', userId, projectId };
    }
    return {
      ok: true,
      actor: { userId, role: access.role, ctx: { actor: userActor(userId) } },
      card,
    };
  }

  private async recordRefusal(
    refused: Extract<Authorized, { ok: false }>,
  ): Promise<void> {
    if (!refused.userId) {
      this.logger.warn('session message from an unlinked Telegram chat');
    }
    await this.audit.record({
      actor: refused.userId ? userActor(refused.userId) : ANONYMOUS_ACTOR,
      action: 'card.message',
      target: { type: 'board_card' },
      projectId: refused.projectId,
      after: { via: 'telegram', reason: refused.reason },
      result: 'denied',
    });
  }
}
