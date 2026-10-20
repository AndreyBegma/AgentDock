import type { AuditResult } from '@nautelle/shared';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit';
import { ANONYMOUS_ACTOR, userActor } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import {
  type ActionRequestDecider,
  ActionRequestsService,
  actionRequestIdOfLink,
} from '../local';
import { httpErrorBody } from '../local/local-error';
import {
  type ActionRequestPress,
  type ActionRequestRefusal,
  actionRequestDecidedText,
  actionRequestErrorText,
  actionRequestKeyboard,
  actionRequestRefusalText,
  decodeActionRequestCallback,
} from './action-request-actions';
import type { ApprovalAnswer } from './telegram-approval.service';
import type {
  TelegramCallbackQuery,
  TelegramReplyMarkup,
} from './telegram-client';
import { TelegramGuard } from './telegram-guard.service';

const KIND = 'action.requested';

type Authorized =
  | { ok: true; decider: ActionRequestDecider }
  | {
      ok: false;
      reason: ActionRequestRefusal;
      userId: string | null;
      projectId: string | null;
      role?: string;
    };

/**
 * Spec 201 D18: Approve and Deny on an `action.requested` message. Like the PR
 * buttons (spec 22 D12), every press is checked again from scratch — the
 * chat's link, that the message was sent to that user for this request, that
 * the user is active and an operator of the project now — and then decided
 * through `ActionRequestsService` as that user, which audits the decision and
 * executes an approval as them. A refusal before that is audited here as
 * `action_request.decided` / `denied` with `meta.via = "telegram"`; a press
 * from an unlinked chat too, with no actor to name.
 */
@Injectable()
export class TelegramActionRequestService {
  private readonly logger = new Logger(TelegramActionRequestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly requests: ActionRequestsService,
    private readonly guard: TelegramGuard,
    private readonly audit: AuditService,
  ) {}

  /**
   * The buttons for notification `notificationId`; null when it is not an
   * `action.requested` one or its request is no longer pending.
   */
  async offer(notificationId: bigint): Promise<TelegramReplyMarkup | null> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      select: { kind: true, userId: true, projectId: true, link: true },
    });
    const actionRequestId = actionRequestIdOfLink(notification?.link ?? null);
    if (notification?.kind !== KIND || !actionRequestId) return null;
    if (!notification.projectId) return null;
    // Buttons only for a recipient who could press them: operator or higher.
    const member = await this.guard.member(
      notification.userId,
      notification.projectId,
      'write',
    );
    if (!member.ok) return null;
    const row = await this.prisma.actionRequest.findFirst({
      where: {
        id: actionRequestId,
        projectId: notification.projectId ?? undefined,
        status: 'pending',
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!row) return null;
    return {
      inline_keyboard: actionRequestKeyboard({
        notificationId,
        actionRequestId,
      }),
    };
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
    const press = decodeActionRequestCallback(query.data);
    if (!press || (chat && chat.type !== 'private')) {
      return answer(actionRequestRefusalText('invalid_button'));
    }
    const authorized = await this.authorize(chatId, press);
    if (!authorized.ok) {
      await this.recordRefusal(authorized, press);
      return answer(actionRequestRefusalText(authorized.reason));
    }
    try {
      const decided = await this.requests.decide(
        authorized.decider,
        press.actionRequestId,
        press.action,
      );
      const failure =
        decided.status === 'failed' &&
        typeof decided.result === 'object' &&
        decided.result !== null &&
        'error' in decided.result &&
        typeof decided.result.error === 'string'
          ? decided.result.error
          : null;
      return answer(
        actionRequestDecidedText(press.action, decided.status, failure),
      );
    } catch (error) {
      // The service audited its own refusal.
      if (!(error instanceof HttpException)) throw error;
      return answer(actionRequestErrorText(httpErrorBody(error).code));
    }
  }

  private async authorize(
    chatId: number,
    press: ActionRequestPress,
  ): Promise<Authorized> {
    const userId = await this.guard.linkedUserId(chatId);
    if (!userId) {
      return { ok: false, reason: 'not_linked', userId: null, projectId: null };
    }
    const notification = await this.prisma.notification.findUnique({
      where: { id: press.notificationId },
      select: { userId: true, kind: true, projectId: true, link: true },
    });
    if (
      notification?.userId !== userId ||
      notification.kind !== KIND ||
      !notification.projectId ||
      actionRequestIdOfLink(notification.link) !== press.actionRequestId
    ) {
      return { ok: false, reason: 'unknown_message', userId, projectId: null };
    }
    const projectId = notification.projectId;
    const check = await this.guard.member(userId, projectId, 'write');
    if (!check.ok) return { ...check, userId, projectId };
    const { user } = check;
    return {
      ok: true,
      decider: {
        projectId,
        role: check.role,
        user: { id: user.id, email: user.email, role: user.role },
        ctx: { actor: userActor(userId) },
        via: 'telegram',
      },
    };
  }

  private async recordRefusal(
    refused: Extract<Authorized, { ok: false }>,
    press: ActionRequestPress,
  ): Promise<void> {
    if (!refused.userId) {
      this.logger.warn('action request button pressed from an unlinked chat');
    }
    const result: AuditResult = 'denied';
    await this.audit.record({
      actor: refused.userId ? userActor(refused.userId) : ANONYMOUS_ACTOR,
      action: 'action_request.decided',
      target: { type: 'action_request', id: press.actionRequestId },
      projectId: refused.projectId,
      after: {
        decision: press.action === 'approve' ? 'approved' : 'denied',
        notificationId: String(press.notificationId),
      },
      result,
      meta: {
        via: 'telegram',
        reason: refused.reason,
        ...(refused.role ? { role: refused.role } : {}),
      },
    });
  }
}
