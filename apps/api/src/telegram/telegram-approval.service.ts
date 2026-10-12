import type { AuditResult } from '@agentdock/shared';
import { roleAtLeast } from '@agentdock/shared/protocol';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import { type ApprovalsCaller, ApprovalsService } from '../approvals';
import { AuditService } from '../audit';
import { SYSTEM_ACTOR, userActor } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { ProjectAccessService } from '../projects';
import {
  type ApprovalAction,
  type ApprovalRefusal,
  type ApprovalTarget,
  approvalKeyboard,
  decodeCallback,
  isHeadSha,
  notePrompt,
  parseNotePrompt,
  refusalText,
  serviceErrorText,
  successText,
} from './approval-actions';
import type {
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramReplyMarkup,
} from './telegram-client';

const KIND = 'pr.awaiting_approval';

/** What the poller sends back for a press or a note. */
export interface ApprovalAnswer {
  chatId: number;
  text: string;
  replyMarkup?: TelegramReplyMarkup;
  /** A press: the callback to answer, with `notice` as its short text. */
  callbackQueryId?: string;
  notice?: string;
}

/** The buttons a `pr.awaiting_approval` message goes out with. */
export interface ApprovalOffer {
  headSha: string;
  replyMarkup: TelegramReplyMarkup;
}

type Authorized =
  | { ok: true; userId: string; caller: ApprovalsCaller }
  | {
      ok: false;
      reason: ApprovalRefusal;
      userId: string | null;
      projectId: string | null;
      role?: string;
    };

const positiveInt = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;

const errorCode = (error: HttpException): string | null => {
  const body = error.getResponse();
  return typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof body.error === 'string'
    ? body.error
    : null;
};

/**
 * Spec 22 D12 (#82): Approve and Request changes from Telegram. Every press,
 * and every note, is checked again from scratch — the chat's link, that the
 * message was sent to that user, that the user is active and an operator of
 * the project now — then goes through #20's `ApprovalsService` at the head the
 * message showed, so a moved head is `head_moved` here as in the UI. Each
 * outcome is audited as `telegram.approval` with `meta.via = "telegram"`;
 * #20 audits the decision itself as well.
 */
@Injectable()
export class TelegramApprovalService {
  private readonly logger = new Logger(TelegramApprovalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalsService,
    private readonly access: ProjectAccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The keyboard for notification `notificationId`, with the head read as the
   * system (#20's 60 s inspection cache). Null — the message goes out with
   * its link only — when the PR is unknown, not open, or the runner cannot
   * answer: a delivery never waits on, or fails for, the buttons.
   */
  async offer(notificationId: bigint): Promise<ApprovalOffer | null> {
    try {
      const notification = await this.prisma.notification.findUnique({
        where: { id: notificationId },
        select: {
          kind: true,
          projectId: true,
          eventId: true,
          lastEventId: true,
        },
      });
      const eventId = notification?.lastEventId ?? notification?.eventId;
      if (notification?.kind !== KIND || !notification.projectId || !eventId) {
        return null;
      }
      const event = await this.prisma.event.findUnique({
        where: { id: eventId },
        select: { data: true },
      });
      const data = event?.data;
      const pr =
        typeof data === 'object' && data !== null && !Array.isArray(data)
          ? positiveInt(data.pr)
          : null;
      if (pr === null) return null;
      const inspection = await this.approvals.inspect(
        {
          projectId: notification.projectId,
          role: 'operator',
          ctx: { actor: SYSTEM_ACTOR },
        },
        pr,
        { fresh: false },
      );
      if (inspection.state !== 'open' || !isHeadSha(inspection.headSha)) {
        return null;
      }
      const target = { notificationId, pr, headSha: inspection.headSha };
      return {
        headSha: inspection.headSha,
        replyMarkup: { inline_keyboard: approvalKeyboard(target) },
      };
    } catch (error) {
      this.logger.warn(
        `no approval buttons for notification ${notificationId}: ${
          error instanceof HttpException
            ? (errorCode(error) ?? error.getStatus())
            : 'internal error'
        }`,
      );
      return null;
    }
  }

  /** A press on Approve or Request changes. */
  async handleCallback(query: TelegramCallbackQuery): Promise<ApprovalAnswer> {
    const chat = query.message?.chat;
    const chatId = chat?.id ?? query.from.id;
    const answer = (text: string, extra: Partial<ApprovalAnswer> = {}) => ({
      chatId,
      text,
      callbackQueryId: query.id,
      notice: text,
      ...extra,
    });
    const press = decodeCallback(query.data);
    if (!press || (chat && chat.type !== 'private')) {
      return answer(refusalText('invalid_button'));
    }
    const target: ApprovalTarget = press;
    const authorized = await this.authorize(chatId, target);
    if (!authorized.ok) {
      await this.recordRefusal(authorized, press.action, target);
      return answer(refusalText(authorized.reason));
    }
    if (press.action === 'request_changes') {
      return answer(notePrompt(target), {
        notice: 'Reply with the note for the worker.',
        replyMarkup: {
          force_reply: true,
          input_field_placeholder: 'Note for the worker',
        },
      });
    }
    return answer(await this.decide(authorized, 'approve', target));
  }

  /**
   * A message that replies to one of this bot's note prompts; null for any
   * other message, which the linking commands handle.
   */
  async handleNoteReply(
    message: TelegramMessage,
    botId: number,
  ): Promise<ApprovalAnswer | null> {
    const prompt = message.reply_to_message;
    if (!prompt || prompt.from?.id !== botId) return null;
    const target = parseNotePrompt(prompt.text);
    if (!target) return null;
    const chatId = message.chat.id;
    if (message.chat.type !== 'private') {
      return { chatId, text: refusalText('invalid_button') };
    }
    const authorized = await this.authorize(chatId, target);
    if (!authorized.ok) {
      await this.recordRefusal(authorized, 'request_changes', target);
      return { chatId, text: refusalText(authorized.reason) };
    }
    return {
      chatId,
      text: await this.decide(
        authorized,
        'request_changes',
        target,
        message.text,
      ),
    };
  }

  /** Through #20's service; its refusal becomes the reply. */
  private async decide(
    authorized: Extract<Authorized, { ok: true }>,
    action: ApprovalAction,
    target: ApprovalTarget,
    note?: string,
  ): Promise<string> {
    const { caller, userId } = authorized;
    const record = (result: AuditResult, meta: object = {}) =>
      this.record(
        userId,
        caller.projectId,
        action,
        target,
        result,
        meta,
        result === 'ok' ? note : undefined,
      );
    try {
      if (action === 'approve') {
        await this.approvals.approve(caller, target.pr, target.headSha);
      } else {
        await this.approvals.requestChanges(
          caller,
          target.pr,
          target.headSha,
          note,
        );
      }
    } catch (error) {
      if (!(error instanceof HttpException)) {
        await record('error', { error: 'internal' });
        throw error;
      }
      const code = errorCode(error);
      await record(error.getStatus() >= 500 ? 'error' : 'denied', {
        reason: code ?? error.getStatus(),
      });
      return serviceErrorText(code, target.pr);
    }
    await record('ok');
    return successText(action, target);
  }

  private async authorize(
    chatId: number,
    target: ApprovalTarget,
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
      where: { id: target.notificationId },
      select: { userId: true, kind: true, projectId: true },
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
      select: { id: true, role: true, status: true },
    });
    if (user?.status !== 'active') {
      return { ok: false, reason: 'inactive_user', userId, projectId };
    }
    const access = await this.access.resolve(user, projectId);
    if (!access) return { ok: false, reason: 'not_member', userId, projectId };
    if (!roleAtLeast(access.role, 'operator')) {
      return {
        ok: false,
        reason: 'role',
        userId,
        projectId,
        role: access.role,
      };
    }
    return {
      ok: true,
      userId,
      caller: {
        projectId,
        role: access.role,
        ctx: { actor: userActor(userId) },
      },
    };
  }

  /** A refusal before #20 was asked. An unlinked chat has no actor to name. */
  private async recordRefusal(
    refused: Extract<Authorized, { ok: false }>,
    action: ApprovalAction,
    target: ApprovalTarget,
  ): Promise<void> {
    if (!refused.userId) {
      this.logger.warn('approval button pressed from an unlinked chat');
      return;
    }
    await this.record(
      refused.userId,
      refused.projectId,
      action,
      target,
      'denied',
      {
        reason: refused.reason,
        ...(refused.role ? { role: refused.role } : {}),
      },
    );
  }

  private record(
    userId: string,
    projectId: string | null,
    action: ApprovalAction,
    target: ApprovalTarget,
    result: AuditResult,
    meta: object,
    /** The note a request for changes sent. */
    note?: string,
  ): Promise<void> {
    return this.audit.record({
      actor: userActor(userId),
      action: 'telegram.approval',
      target: { type: 'pull_request', id: String(target.pr) },
      projectId,
      after: {
        pr: target.pr,
        headSha: target.headSha,
        decision: action === 'approve' ? 'approved' : 'changes_requested',
        notificationId: String(target.notificationId),
        ...(note === undefined ? {} : { note }),
      },
      result,
      meta: { ...meta, via: 'telegram' },
    });
  }
}
