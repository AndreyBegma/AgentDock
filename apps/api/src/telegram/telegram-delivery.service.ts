import { miniAppTargetOfLink } from '@nautelle/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { BotTokenStore, TelegramDeliveryLedger } from '../notifications';
import { formatDigest, formatMessage } from './markdown-v2';
import { withOpenInApp } from './mini-app-buttons';
import { TelegramActionRequestService } from './telegram-action-request.service';
import { TelegramApprovalService } from './telegram-approval.service';
import { TelegramCardService } from './telegram-card.service';
import {
  type InlineKeyboardButton,
  TelegramApiError,
  TelegramClient,
  type TelegramReplyMarkup,
} from './telegram-client';
import { TELEGRAM_OPTIONS, type TelegramOptions } from './telegram-options';
import { TelegramSessionMessageService } from './telegram-session-message.service';

/** What one pass did; the e2e suites assert on it. */
export interface DeliveryPass {
  sent: number;
  failed: number;
  digests: number;
  /** The pass stopped early: a 429, or the token was refused. */
  stopped: 'rate_limited' | 'token_rejected' | null;
}

const failure = (
  error: unknown,
): {
  message: string;
  options: { retryAfterS?: number; permanent?: boolean };
} =>
  error instanceof TelegramApiError
    ? {
        message: error.message,
        options: {
          ...(error.retryAfterS !== undefined
            ? { retryAfterS: error.retryAfterS }
            : {}),
          permanent: error.permanent,
        },
      }
    : // Not Telegram's answer: a bug here. Never its text — it could hold anything.
      { message: 'internal error while sending', options: {} };

/** `markup`'s inline keyboard with `rows` added under it. */
const withRows = (
  markup: TelegramReplyMarkup | null | undefined,
  rows: InlineKeyboardButton[][] | null,
): TelegramReplyMarkup | undefined => {
  if (!rows || rows.length === 0) return markup ?? undefined;
  if (!markup) return { inline_keyboard: rows };
  return 'inline_keyboard' in markup
    ? { inline_keyboard: [...markup.inline_keyboard, ...rows] }
    : markup;
};

/**
 * Sends what `TelegramDeliveryLedger` hands out (spec 22 D6, D10): each
 * claimed message, then each due digest, and reports every result back. A 429
 * ends the pass — Telegram's limit is per bot, so the next send would be
 * refused too; the rest of the claim waits out its lease. A refused token
 * ends it without touching the rows, so nothing is lost while an admin fixes
 * the bot.
 */
@Injectable()
export class TelegramDeliveryService {
  private readonly logger = new Logger(TelegramDeliveryService.name);

  constructor(
    private readonly ledger: TelegramDeliveryLedger,
    private readonly tokens: BotTokenStore,
    private readonly client: TelegramClient,
    private readonly approvals: TelegramApprovalService,
    private readonly actionRequests: TelegramActionRequestService,
    private readonly sessions: TelegramSessionMessageService,
    private readonly cards: TelegramCardService,
    @Inject(TELEGRAM_OPTIONS) private readonly options: TelegramOptions,
  ) {}

  async deliverOnce(now = new Date()): Promise<DeliveryPass> {
    const pass: DeliveryPass = {
      sent: 0,
      failed: 0,
      digests: 0,
      stopped: null,
    };
    const bot = await this.tokens.read();
    if (!bot.ok) return pass;
    const claim = await this.ledger.claim(now);

    for (const message of claim.messages) {
      // D12: a PR awaiting approval goes out with the buttons when its head is known.
      const offer =
        message.content.kind === 'pr.awaiting_approval'
          ? await this.approvals.offer(message.notificationId)
          : null;
      // Spec 201 D18: an action request goes out with Approve / Deny while pending.
      const actionMarkup =
        message.content.kind === 'action.requested'
          ? await this.actionRequests
              .offer(message.notificationId)
              .catch(() => null)
          : null;
      // #489 M2: a card waiting on its session goes out with the question's
      // options and takes a reply as a message to the session.
      const session =
        message.content.kind === 'card.waiting'
          ? await this.sessions.offer(message.notificationId)
          : null;
      // #578: a card's notification carries the actions its state allows,
      // under the buttons above (which stay as they are).
      const cardRows = await this.cards.offer(message.notificationId);
      try {
        await this.client.sendMessage(
          bot.token,
          message.chatId,
          formatMessage(
            message.content,
            this.options.appUrl,
            offer?.headSha ?? null,
          ) + (session?.footer ?? ''),
          false,
          // #580: a card's message opens that card in the Mini App too, below
          // #578's card actions.
          withOpenInApp(
            withRows(
              offer?.replyMarkup ?? actionMarkup ?? session?.replyMarkup,
              cardRows,
            ),
            this.options.appUrl,
            miniAppTargetOfLink(message.content.link),
          ),
        );
        await this.ledger.markSent(message.id, now);
        pass.sent += 1;
      } catch (error) {
        pass.stopped = this.stopReason(error);
        if (pass.stopped === 'token_rejected') return pass;
        const { message: reason, options } = failure(error);
        this.logger.warn(`Telegram delivery ${message.id} failed: ${reason}`);
        await this.ledger.markFailed(message.id, reason, options, now);
        pass.failed += 1;
        if (pass.stopped) return pass;
      }
    }

    for (const digest of claim.digests) {
      try {
        await this.client.sendMessage(
          bot.token,
          digest.chatId,
          formatDigest(digest.items, this.options.appUrl),
        );
        await this.ledger.markDigestSent(digest.digestId, now);
        pass.digests += 1;
      } catch (error) {
        pass.stopped = this.stopReason(error);
        if (pass.stopped === 'token_rejected') return pass;
        const { message: reason, options } = failure(error);
        this.logger.warn(
          `Telegram digest ${digest.digestId} failed: ${reason}`,
        );
        await this.ledger.markDigestFailed(
          digest.digestId,
          reason,
          options,
          now,
        );
        pass.failed += 1;
        if (pass.stopped) return pass;
      }
    }
    return pass;
  }

  private stopReason(error: unknown): DeliveryPass['stopped'] {
    if (!(error instanceof TelegramApiError)) return null;
    if (error.tokenRejected) return 'token_rejected';
    return error.retryAfterS !== undefined ? 'rate_limited' : null;
  }
}
