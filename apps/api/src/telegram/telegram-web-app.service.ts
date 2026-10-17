import {
  AUTH_ERROR,
  type LoginDeniedReason,
  type TelegramSignInResponse,
} from '@agentdock/shared';
import { type HttpException, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit';
import {
  ANONYMOUS_ACTOR,
  type RequestOrigin,
  userActor,
} from '../audit/audit.types';
import { authError, SessionService, toPublicUser } from '../auth';
import type { IssuedSession } from '../auth/session.service';
import { PrismaService } from '../database/prisma.service';
import { BotTokenStore } from '../notifications';
import { TELEGRAM_OPTIONS, type TelegramOptions } from './telegram-options';
import { TelegramProjectService } from './telegram-project.service';
import { verifyInitData } from './web-app-init-data';

export interface TelegramSignIn extends TelegramSignInResponse {
  session: IssuedSession;
}

/**
 * #580: signs a Telegram Mini App in. Its `initData` must carry the bot's
 * HMAC and be fresh; the Telegram user it names is the private chat a linked
 * account is bound to (spec 22 D9), so that account gets the ordinary web
 * session — the same cookie, the same role checks as a password sign-in.
 * Nothing about the account is told to a Telegram user it is not linked to.
 */
@Injectable()
export class TelegramWebAppService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: BotTokenStore,
    private readonly sessions: SessionService,
    private readonly projects: TelegramProjectService,
    private readonly audit: AuditService,
    @Inject(TELEGRAM_OPTIONS) private readonly options: TelegramOptions,
  ) {}

  async signIn(
    initData: string,
    origin: RequestOrigin,
    now = new Date(),
  ): Promise<TelegramSignIn> {
    const bot = await this.tokens.read();
    if (!bot.ok) {
      throw authError(
        409,
        AUTH_ERROR.telegramNotConfigured,
        'The Telegram bot is not configured',
      );
    }
    const check = verifyInitData(
      initData,
      bot.token,
      now,
      this.options.initDataMaxAgeS,
    );
    if (!check.ok) {
      throw await this.deny(
        origin,
        null,
        'telegram_invalid',
        check.reason === 'expired'
          ? authError(
              401,
              AUTH_ERROR.telegramExpired,
              'This Mini App session is too old. Close it and open it again from the bot.',
            )
          : authError(
              401,
              AUTH_ERROR.telegramInvalid,
              'Telegram did not sign this request',
            ),
      );
    }

    const chatId = check.init.userId;
    const link = await this.prisma.telegramLink.findUnique({
      where: { chatId: BigInt(chatId) },
      include: { user: true },
    });
    // A disabled or pending account gets the unlinked answer: its link
    // cannot sign anyone in, and the answer must not say more than that.
    if (!link || link.user.status !== 'active') {
      throw await this.deny(
        origin,
        String(chatId),
        'telegram_not_linked',
        authError(
          403,
          AUTH_ERROR.telegramNotLinked,
          'This Telegram account is not linked to AgentDock. Link it in AgentDock → Account → Notifications.',
        ),
      );
    }

    const session = await this.sessions.create(link.userId, origin);
    await this.audit.record({
      actor: userActor(link.userId),
      origin,
      action: 'auth.login',
      target: { type: 'user', id: link.userId },
      result: 'ok',
      meta: { sessionId: session.sessionId, via: 'telegram' },
    });
    const current = await this.projects.current(chatId, 'read');
    return {
      user: toPublicUser(link.user),
      projectId: current.ok ? current.project.id : null,
      session,
    };
  }

  /** Records a refused sign-in — folded, as a refused password is — and returns its error. */
  private async deny(
    origin: RequestOrigin,
    telegramUserId: string | null,
    reason: LoginDeniedReason,
    error: HttpException,
  ): Promise<HttpException> {
    await this.audit.recordFolded({
      actor: ANONYMOUS_ACTOR,
      origin,
      action: 'auth.login',
      target: { type: 'telegram_user', id: telegramUserId },
      result: 'denied',
      meta: { reason },
    });
    return error;
  }
}
