import {
  type AuditResult,
  type BoardCardDetail,
  CARD_FEEDBACK_MAX,
  CARD_FINISHED_EVENT,
  CARD_WAITING_EVENT,
  CARDS_SUGGESTED_EVENT,
  type CardPullRequestView,
  type CardReviewAction,
  cardReviewActions,
  type Role,
  type SessionMessageInput,
} from '@agentdock/shared';
import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit';
import { userActor } from '../audit/audit.types';
import { BoardService } from '../board/board.service';
import { BoardInboxService } from '../board/board-inbox.service';
import { BoardRoundsService } from '../board/board-rounds.service';
import { BoardSessionMessages } from '../board/board-session-message.service';
import type { BoardActor } from '../board/board-work';
import { SlotSessionMessages } from '../control/slot-session-message.service';
import { PrismaService } from '../database/prisma.service';
import { httpErrorBody } from '../local/local-error';
import { cardKeyboard, cardText } from './board-actions';
import {
  acceptConfirm,
  actionOfWord,
  boardErrorText,
  CANCELLED_TEXT,
  CARD_ACTION_CALLBACK,
  CARD_CONFIRM_CALLBACK,
  CARD_MERGE_CALLBACK,
  type CardRefusal,
  cardRefusalText,
  feedbackPrompt,
  finishConfirm,
  HEAD_MOVED_TEXT,
  headPrefix,
  isConfirmStep,
  messagePrompt,
  parseCardPrompt,
  resultLine,
  reviewKeyboard,
  suggestionRows,
} from './card-actions';
import {
  sessionErrorText,
  sessionOutcomeText,
} from './session-message-actions';
import type {
  InlineKeyboardButton,
  TelegramCallbackQuery,
  TelegramMessage,
} from './telegram-client';
import { TelegramGuard } from './telegram-guard.service';
import { TELEGRAM_OPTIONS, type TelegramOptions } from './telegram-options';
import { boardReply } from './telegram-project.service';
import type { TelegramAnswer } from './telegram-router';

/** What the notifications this service adds buttons to are about. */
const CARD_KINDS = new Set([
  'card.finished',
  'card.waiting',
  'pr.awaiting_approval',
  'cards.suggested',
]);
/** A `cards.suggested` message gets a row for at most this many cards. */
const SUGGESTION_ROWS_MAX = 5;

/** A card a chat may act on, with who acts. */
interface Acting {
  actor: BoardActor;
  userId: string;
  role: Role;
  project: { id: string; displayName: string; baseBranch: string | null };
  shortId: string;
  card: BoardCardDetail;
}

type Authorized =
  | ({ ok: true } & Acting)
  | {
      ok: false;
      reason: CardRefusal;
      userId: string | null;
      projectId: string | null;
      cardId: string | null;
      role?: Role;
    };

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * #578: the review-side card actions from Telegram — Feedback, Message
 * session, Accept, Finish, Create pull request, and Accept or Dismiss on an
 * Inbox suggestion — on #576's card message (`/card <n>`) and on the card
 * notifications. Only the actions the card's state allows are offered
 * (`cardReviewActions`, the web's rules), and only to an operator or higher.
 * Every press and reply is checked from scratch (ADR-0046 §6): the chat's
 * link, an active member with the operator role, and the card's state now,
 * so a forged or stale button changes nothing. The work goes through the
 * Board services the web calls, which audit it; each outcome is also
 * audited as `telegram.card` with `meta.via = "telegram"`.
 */
@Injectable()
export class TelegramCardService {
  private readonly logger = new Logger(TelegramCardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly guard: TelegramGuard,
    private readonly board: BoardService,
    private readonly rounds: BoardRoundsService,
    private readonly inbox: BoardInboxService,
    private readonly cardMessages: BoardSessionMessages,
    private readonly slotMessages: SlotSessionMessages,
    private readonly audit: AuditService,
    @Inject(TELEGRAM_OPTIONS) private readonly options: TelegramOptions,
  ) {}

  /**
   * The card buttons of notification `notificationId`: the actions its card
   * allows now, for a recipient who may press them. Null for another kind, a
   * viewer, or a card gone. Never throws: a delivery does not fail for them.
   */
  async offer(
    notificationId: bigint,
  ): Promise<InlineKeyboardButton[][] | null> {
    try {
      const notification = await this.prisma.notification.findUnique({
        where: { id: notificationId },
        select: {
          kind: true,
          userId: true,
          projectId: true,
          eventId: true,
          lastEventId: true,
        },
      });
      if (!notification?.projectId || !CARD_KINDS.has(notification.kind)) {
        return null;
      }
      const { projectId } = notification;
      const member = await this.guard.member(
        notification.userId,
        projectId,
        'write',
      );
      if (!member.ok) return null;
      const eventId = notification.lastEventId ?? notification.eventId;
      const event = eventId
        ? await this.prisma.event.findUnique({
            where: { id: eventId },
            select: { type: true, data: true },
          })
        : null;
      const data = record(event?.data);
      if (!event || !data) return null;
      if (event.type === CARDS_SUGGESTED_EVENT) {
        const ids = Array.isArray(data.cardIds)
          ? data.cardIds.filter((id): id is string => typeof id === 'string')
          : [];
        const cards = await this.prisma.boardCard.findMany({
          where: { id: { in: ids }, projectId, column: 'inbox' },
          select: { shortId: true, number: true },
          orderBy: { number: 'asc' },
          take: SUGGESTION_ROWS_MAX,
        });
        return cards.length > 0 ? suggestionRows(cards) : null;
      }
      const where =
        event.type === CARD_FINISHED_EVENT || event.type === CARD_WAITING_EVENT
          ? typeof data.cardId === 'string'
            ? { id: data.cardId, projectId }
            : null
          : typeof data.pr === 'number'
            ? { projectId, prNumber: data.pr }
            : null;
      if (!where) return null;
      const row = await this.prisma.boardCard.findFirst({
        where,
        select: { shortId: true, number: true },
      });
      if (!row) return null;
      const card = await this.board.detail(projectId, row.number, member.role);
      const actions = cardReviewActions(card);
      return actions.length > 0 ? reviewKeyboard(row.shortId, actions) : null;
    } catch (error) {
      this.logger.warn(
        `no card buttons for notification ${notificationId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /** A press on a card action, a confirm step or Accept and merge. */
  async handleCallback(query: TelegramCallbackQuery): Promise<TelegramAnswer> {
    const chat = query.message?.chat;
    const chatId = chat?.id ?? query.from.id;
    const messageId = query.message?.message_id;
    const answer = (
      text: string,
      extra: Partial<TelegramAnswer> = {},
    ): TelegramAnswer => ({
      chatId,
      text,
      callbackQueryId: query.id,
      notice: text,
      ...extra,
    });
    const refuse = async (
      refused: Extract<Authorized, { ok: false }>,
      action: string,
    ) => {
      await this.recordRefusal(refused, action);
      return answer(cardRefusalText(refused.reason));
    };
    if (chat && chat.type !== 'private') {
      return answer(cardRefusalText('invalid_button'));
    }
    const press = CARD_ACTION_CALLBACK.decode(query.data);
    const confirm = CARD_CONFIRM_CALLBACK.decode(query.data);
    const merge = CARD_MERGE_CALLBACK.decode(query.data);

    // An edit without a keyboard keeps the old buttons: clear them.
    const cleared = { replyMarkup: { inline_keyboard: [] } };
    if (confirm?.step === 'cancel') {
      return answer(CANCELLED_TEXT, { ...cleared, editMessageId: messageId });
    }
    const shortId = press?.card ?? confirm?.card ?? merge?.card;
    const action: CardReviewAction | null = press
      ? actionOfWord(press.action)
      : confirm
        ? isConfirmStep(confirm.step)
          ? (confirm.step as 'accept' | 'finish')
          : null
        : merge
          ? 'accept'
          : null;
    if (!shortId || !action) return answer(cardRefusalText('invalid_button'));
    const authorized = await this.authorize(chatId, shortId, action);
    if (!authorized.ok) return refuse(authorized, action);
    const { card } = authorized;

    // The first tap of a reply action or of a confirmed one: ask.
    if (press) {
      switch (action) {
        case 'feedback':
          return answer(feedbackPrompt(card.label, shortId), {
            notice: 'Reply with your feedback.',
            replyMarkup: {
              force_reply: true,
              input_field_placeholder: `Feedback for ${card.label}`,
            },
          });
        case 'message':
          return answer(messagePrompt(card.label, this.slotOf(card), shortId), {
            notice: 'Reply with your message.',
            replyMarkup: {
              force_reply: true,
              input_field_placeholder: `Message for ${card.label}`,
            },
          });
        case 'accept': {
          const prompt = acceptConfirm(
            {
              ...card,
              shortId,
              baseBranch: authorized.project.baseBranch,
            },
            await this.pullRequest(authorized),
          );
          return answer(prompt.text, {
            notice: `Accept ${card.label}?`,
            replyMarkup: { inline_keyboard: prompt.keyboard },
          });
        }
        case 'finish': {
          const prompt = finishConfirm({ label: card.label, shortId });
          return answer(prompt.text, {
            notice: `Mark ${card.label} finished?`,
            replyMarkup: { inline_keyboard: prompt.keyboard },
          });
        }
        default:
          break;
      }
    }

    // Accept and merge: bound to the head the prompt showed.
    let headSha: string | null = null;
    if (merge) {
      const pr = await this.pullRequest(authorized);
      if (!pr || headPrefix(pr.headSha) !== merge.head) {
        await this.record(authorized, 'accept', 'denied', {
          reason: 'head_moved',
        });
        return answer(HEAD_MOVED_TEXT, {
          ...cleared,
          editMessageId: messageId,
        });
      }
      headSha = pr.headSha;
    }
    const text = await this.act(authorized, action, headSha);
    return {
      ...answer(text.notice),
      ...cleared,
      ...text.answer,
      editMessageId: messageId,
    };
  }

  /**
   * A reply to a Feedback or Message session prompt; null for a message that
   * answers neither.
   */
  async handleReply(
    message: TelegramMessage,
    botId: number,
  ): Promise<TelegramAnswer | null> {
    const prompt = message.reply_to_message;
    if (!prompt || prompt.from?.id !== botId) return null;
    const target = parseCardPrompt(prompt.text);
    if (!target) return null;
    const chatId = message.chat.id;
    if (message.chat.type !== 'private') {
      return { chatId, text: cardRefusalText('invalid_button') };
    }
    const authorized = await this.authorize(chatId, target.card, target.action);
    if (!authorized.ok) {
      await this.recordRefusal(authorized, target.action);
      return { chatId, text: cardRefusalText(authorized.reason) };
    }
    const text = message.text?.trim() ?? '';
    if (
      text === '' ||
      (target.action === 'feedback' && text.length > CARD_FEEDBACK_MAX)
    ) {
      await this.record(authorized, target.action, 'denied', {
        reason: 'invalid_text',
      });
      return {
        chatId,
        text:
          text === ''
            ? cardRefusalText('invalid_text')
            : `Feedback is at most ${CARD_FEEDBACK_MAX} characters; nothing was sent.`,
      };
    }
    if (target.action === 'message') {
      return { chatId, text: await this.message(authorized, text) };
    }
    const done = await this.act(authorized, 'feedback', null, text);
    return { chatId, ...done.answer };
  }

  /** Through the Board services; a refusal of theirs becomes the reply. */
  private async act(
    acting: Acting,
    action: CardReviewAction,
    headSha: string | null,
    feedback?: string,
  ): Promise<{
    notice: string;
    answer: Pick<TelegramAnswer, 'text' | 'replyMarkup'>;
  }> {
    const { project, card, actor } = acting;
    const { number } = card;
    let after: BoardCardDetail | null = null;
    let line: string;
    try {
      switch (action) {
        case 'accept': {
          const done = await this.board.accept(
            project.id,
            number,
            headSha ? { merge: { headSha } } : {},
            actor,
          );
          after = done;
          line = resultLine('accept', card.label, {
            merged:
              done.merge && !done.merge.alreadyMerged ? card.prNumber : null,
          });
          break;
        }
        case 'finish':
          after = await this.board.finish(project.id, number, actor);
          line = resultLine('finish', card.label);
          break;
        case 'feedback':
          after = await this.rounds.feedback(
            project.id,
            number,
            { text: feedback ?? '' },
            actor,
          );
          line = resultLine('feedback', card.label);
          break;
        case 'collect': {
          const done = await this.board.collect(project.id, number, actor);
          after = done;
          line = resultLine('collect', card.label, { collect: done.collect });
          break;
        }
        case 'accept_suggestion':
          after = await this.inbox.accept(project.id, number, {}, actor);
          line = resultLine('accept_suggestion', card.label);
          break;
        case 'dismiss':
          await this.inbox.dismiss(project.id, number, actor);
          line = resultLine('dismiss', card.label);
          break;
        default:
          return {
            notice: cardRefusalText('invalid_button'),
            answer: { text: cardRefusalText('invalid_button') },
          };
      }
    } catch (error) {
      if (!(error instanceof HttpException)) {
        await this.record(acting, action, 'error', { error: 'internal' });
        throw error;
      }
      const body = httpErrorBody(error);
      const response = record(error.getResponse());
      const reason =
        typeof response?.reason === 'string' ? response.reason : null;
      await this.record(
        acting,
        action,
        error.getStatus() >= 500 ? 'error' : 'denied',
        {
          reason: body.code ?? error.getStatus(),
        },
      );
      const text = boardErrorText(body.code, reason);
      return { notice: text, answer: { text } };
    }
    await this.record(acting, action, 'ok', {});
    if (!after)
      return { notice: line, answer: { text: boardReply(project, line) } };
    return {
      notice: line,
      answer: this.view(project, acting.shortId, after, `✓ ${line}`),
    };
  }

  /** Message session: the card's round, or a fleet card's slot (ADR-0045 §5). */
  private async message(acting: Acting, text: string): Promise<string> {
    const { card, project, actor } = acting;
    const slot = this.slotOf(card);
    const question = card.round?.pendingQuestion;
    const input: SessionMessageInput =
      !slot && question?.other === true
        ? { kind: 'other', questionKey: question.key, text }
        : { kind: 'text', text };
    try {
      const { outcome } = slot
        ? await this.slotMessages.message(
            {
              projectId: project.id,
              role: actor.role,
              user: await this.prisma.user.findUniqueOrThrow({
                where: { id: acting.userId },
                select: { id: true, email: true },
              }),
              ctx: actor.ctx,
            },
            slot,
            input,
            'telegram',
          )
        : await this.cardMessages.message(
            project.id,
            card.number,
            input,
            actor,
            'telegram',
          );
      await this.record(acting, 'message', 'ok', { outcome });
      return sessionOutcomeText(outcome);
    } catch (error) {
      // The session-message service audited it.
      if (!(error instanceof HttpException)) throw error;
      const { code } = httpErrorBody(error);
      await this.record(acting, 'message', 'error', { reason: code });
      return sessionErrorText(code);
    }
  }

  /** The slot a fleet card's message goes to; null for a card's own round. */
  private slotOf(card: BoardCardDetail): string | null {
    return card.source === 'fleet' ? (card.fleet?.slot ?? null) : null;
  }

  /** The card's PR as Accept would merge it; null when it cannot be read. */
  private async pullRequest(
    acting: Acting,
  ): Promise<CardPullRequestView | null> {
    if (acting.card.prNumber === null || acting.card.source === 'fleet') {
      return null;
    }
    try {
      return await this.board.pullRequest(
        acting.project.id,
        acting.card.number,
        acting.actor,
      );
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      return null;
    }
  }

  /** #576's card message, with the review actions and `service` on top. */
  private view(
    project: Acting['project'],
    shortId: string,
    card: BoardCardDetail,
    service: string,
  ): Pick<TelegramAnswer, 'text' | 'replyMarkup'> {
    return {
      text: boardReply(project, cardText(card, service)),
      replyMarkup: {
        inline_keyboard: cardKeyboard(
          project.id,
          card,
          true,
          this.options.appUrl,
          reviewKeyboard(shortId, cardReviewActions(card)),
        ),
      },
    };
  }

  /**
   * Who acts on card `shortId` and whether its state allows `action` now.
   * The card is found by its `shortId`, unique across projects; its project
   * is the one checked.
   */
  private async authorize(
    chatId: number,
    shortId: string,
    action: CardReviewAction,
  ): Promise<Authorized> {
    const row = await this.prisma.boardCard.findUnique({
      where: { shortId },
      select: {
        id: true,
        number: true,
        project: { select: { id: true, displayName: true, baseBranch: true } },
      },
    });
    const allowed = row
      ? await this.guard.authorize(chatId, row.project.id, 'write')
      : null;
    if (!row || !allowed) {
      const userId = await this.guard.linkedUserId(chatId);
      return {
        ok: false,
        reason: userId ? 'unknown_card' : 'not_linked',
        userId,
        projectId: null,
        cardId: null,
      };
    }
    if (!allowed.ok) {
      return {
        ok: false,
        reason: allowed.reason,
        userId: allowed.userId,
        projectId: row.project.id,
        cardId: row.id,
        ...(allowed.role ? { role: allowed.role } : {}),
      };
    }
    const card = await this.board.detail(
      row.project.id,
      row.number,
      allowed.role,
    );
    if (!cardReviewActions(card).includes(action)) {
      return {
        ok: false,
        reason: 'not_allowed',
        userId: allowed.user.id,
        projectId: row.project.id,
        cardId: row.id,
      };
    }
    return {
      ok: true,
      userId: allowed.user.id,
      role: allowed.role,
      actor: {
        userId: allowed.user.id,
        role: allowed.role,
        ctx: { actor: userActor(allowed.user.id) },
      },
      project: row.project,
      shortId,
      card,
    };
  }

  /** A refusal before a Board service was asked. An unlinked chat has no actor. */
  private async recordRefusal(
    refused: Extract<Authorized, { ok: false }>,
    action: string,
  ): Promise<void> {
    if (!refused.userId) {
      this.logger.warn('card action from an unlinked Telegram chat');
      return;
    }
    await this.audit.record({
      actor: userActor(refused.userId),
      action: 'telegram.card',
      target: { type: 'board_card', id: refused.cardId },
      projectId: refused.projectId,
      after: { action },
      result: 'denied',
      meta: {
        reason: refused.reason,
        ...(refused.role ? { role: refused.role } : {}),
        via: 'telegram',
      },
    });
  }

  private record(
    acting: Acting,
    action: CardReviewAction,
    result: AuditResult,
    meta: object,
  ): Promise<void> {
    return this.audit.record({
      actor: userActor(acting.userId),
      action: 'telegram.card',
      target: { type: 'board_card', id: acting.card.id },
      projectId: acting.project.id,
      after: { number: acting.card.number, action },
      result,
      meta: { ...meta, via: 'telegram' },
    });
  }
}
