import {
  AUTH_ERROR,
  type LoginDeniedReason,
  type PublicUser,
} from '@nautelle/shared';
import { type HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import {
  ANONYMOUS_ACTOR,
  type RequestOrigin,
  userActor,
} from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { authError, sourceThrottled } from './auth-error';
import type { AuthContext } from './auth-request';
import type { ChangePasswordDto, LoginDto, RegisterDto } from './dto';
import { LoginThrottle } from './login-throttle';
import { LoginThrottleAlerts } from './login-throttle-alerts';
import { hashPassword, verifyPassword } from './password';
import { type IssuedSession, SessionService } from './session.service';
import { toPublicUser } from './user-mapper';

const invalidCredentials = () =>
  authError(401, AUTH_ERROR.invalidCredentials, 'Invalid email or password');

export interface LoginResult {
  user: PublicUser;
  session: IssuedSession;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly throttle: LoginThrottle,
    private readonly alerts: LoginThrottleAlerts,
  ) {}

  async register(dto: RegisterDto, origin: RequestOrigin): Promise<void> {
    if (!(await this.settings.isRegistrationOpen())) {
      throw authError(
        403,
        AUTH_ERROR.registrationClosed,
        'Registration is closed',
      );
    }
    const passwordHash = await hashPassword(dto.password);
    try {
      const user = await this.prisma.user.create({
        data: { email: dto.email, name: dto.name || null, passwordHash },
      });
      await this.audit.record({
        actor: ANONYMOUS_ACTOR,
        origin,
        action: 'auth.register',
        target: { type: 'user', id: user.id },
        after: { email: user.email, name: user.name, status: user.status },
        result: 'ok',
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw authError(409, AUTH_ERROR.emailTaken, 'Email already registered');
      }
      throw error;
    }
  }

  /**
   * Wrong email, wrong password and a rejected or disabled account all fail
   * the same way (spec D8, D9). Only a correct password on a pending account
   * says so, because it proves the caller owns the account.
   *
   * Failures are counted per (email, IP) and make only that source wait
   * (C-109): the owner signing in from elsewhere is never delayed.
   */
  async login(dto: LoginDto, origin: RequestOrigin): Promise<LoginResult> {
    // Every refusal is recorded against the email, never the account: the
    // record must not tell an auditor more than the response told the caller.
    // A flood of them folds into one record per (email, IP, minute).
    const deny = async (reason: LoginDeniedReason, error: HttpException) => {
      await this.audit.recordFolded({
        actor: ANONYMOUS_ACTOR,
        origin,
        action: 'auth.login',
        target: { type: 'email', id: dto.email },
        result: 'denied',
        meta: { reason },
      });
      return error;
    };
    const wait = await this.throttle.waitMs(dto.email, origin.ip);
    if (wait > 0) throw await deny('throttled', sourceThrottled(wait));

    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    const passwordOk = await verifyPassword(
      user?.passwordHash ?? null,
      dto.password,
    );
    if (!user || !passwordOk) {
      await this.countFailure(dto.email, origin, user?.id ?? null);
      throw await deny('invalid_credentials', invalidCredentials());
    }
    await this.throttle.clear(dto.email, origin.ip);

    if (user.status === 'pending') {
      throw await deny(
        'pending_approval',
        authError(
          403,
          AUTH_ERROR.pendingApproval,
          'Account is waiting for administrator approval',
        ),
      );
    }
    if (user.status !== 'active') {
      throw await deny('invalid_credentials', invalidCredentials());
    }

    const session = await this.sessions.create(user.id, origin);
    await this.audit.record({
      actor: userActor(user.id),
      origin,
      action: 'auth.login',
      target: { type: 'user', id: user.id },
      result: 'ok',
      meta: { sessionId: session.sessionId },
    });
    return { user: toPublicUser(user), session };
  }

  /** Counts a wrong password and tells admins when an account becomes throttled. */
  private async countFailure(
    email: string,
    origin: RequestOrigin,
    userId: string | null,
  ): Promise<void> {
    const at = new Date();
    const { failures, accountThrottled } = await this.throttle.fail(
      email,
      origin.ip,
      at,
    );
    if (accountThrottled && userId) {
      await this.alerts.accountThrottled({
        userId,
        email,
        ip: origin.ip,
        failures,
        at,
      });
    }
  }

  /** Changes the caller's password and ends every other session of theirs (spec D11). */
  async changePassword(
    auth: AuthContext,
    dto: ChangePasswordDto,
    origin: RequestOrigin,
  ) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: auth.user.id },
    });
    // The login counter (C-109): a stolen session guesses no faster than a stranger.
    const wait = await this.throttle.waitMs(user.email, origin.ip);
    if (wait > 0) throw sourceThrottled(wait);
    if (!(await verifyPassword(user.passwordHash, dto.currentPassword))) {
      await this.countFailure(user.email, origin, user.id);
      throw authError(
        403,
        AUTH_ERROR.invalidCredentials,
        'Current password is wrong',
      );
    }
    await this.throttle.clear(user.email, origin.ip);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(dto.newPassword) },
    });
    await this.sessions.revokeAll(user.id, auth.sessionId);
    await this.audit.record({
      actor: userActor(user.id),
      origin,
      action: 'auth.password_change',
      target: { type: 'user', id: user.id },
      result: 'ok',
    });
  }
}
