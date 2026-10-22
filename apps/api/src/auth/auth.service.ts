import {
  AUTH_ERROR,
  type LoginDeniedReason,
  type PublicUser,
  type TwoFactorSetupResponse,
  type TwoFactorStatus,
} from '@nautelle/shared';
import { type HttpException, Injectable } from '@nestjs/common';
import { Prisma, type User } from '@prisma/client';
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
import type {
  ChangePasswordDto,
  LoginDto,
  RegisterDto,
  TwoFactorConfirmDto,
} from './dto';
import { LoginThrottle } from './login-throttle';
import { LoginThrottleAlerts } from './login-throttle-alerts';
import { hashPassword, verifyPassword } from './password';
import { type IssuedSession, SessionService } from './session.service';
import { type SecondFactor, TwoFactorService } from './two-factor.service';
import { toPublicUser } from './user-mapper';

const invalidCredentials = () =>
  authError(401, AUTH_ERROR.invalidCredentials, 'Invalid email or password');

const invalidCode = (status: 401 | 403) =>
  authError(
    status,
    AUTH_ERROR.twoFactorInvalid,
    'The code is wrong, expired or already used',
  );

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
    private readonly twoFactor: TwoFactorService,
  ) {}

  async register(dto: RegisterDto, origin: RequestOrigin): Promise<void> {
    if (!(await this.settings.isRegistrationOpen())) {
      throw authError(
        403,
        AUTH_ERROR.registrationClosed,
        'Registration is closed',
      );
    }
    // Hashed before the email is looked at, so a taken email costs the same
    // time as a new one.
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
        // The caller gets the same answer as for a new email (L-12): the
        // response must not say which addresses have an account. The attempt
        // is kept for admins, against the email and not the account.
        await this.audit.recordFolded({
          actor: ANONYMOUS_ACTOR,
          origin,
          action: 'auth.register',
          target: { type: 'email', id: dto.email },
          result: 'denied',
          meta: { reason: 'email_taken' },
        });
        return;
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
   *
   * An account with two-factor sign-in (C-189) also needs `code`: without one
   * the answer is 401 `two_factor_required`, and a wrong one counts as a
   * failure. The source's count is cleared only once both factors passed, so
   * the password alone cannot reset the wait between guessed codes.
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
    const needsCode = user.totpEnabledAt !== null;
    if (!needsCode) await this.throttle.clear(dto.email, origin.ip);

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

    let secondFactor: SecondFactor | null = null;
    if (needsCode) {
      if (!dto.code) {
        throw authError(
          401,
          AUTH_ERROR.twoFactorRequired,
          'Enter the code from your authenticator app',
        );
      }
      secondFactor = await this.twoFactor.verify(user, dto.code);
      if (!secondFactor) {
        await this.countFailure(dto.email, origin, user.id);
        throw await deny('two_factor_invalid', invalidCode(401));
      }
      await this.throttle.clear(dto.email, origin.ip);
    }

    const session = await this.sessions.create(user.id, origin);
    await this.audit.record({
      actor: userActor(user.id),
      origin,
      action: 'auth.login',
      target: { type: 'user', id: user.id },
      result: 'ok',
      meta: {
        sessionId: session.sessionId,
        ...(secondFactor ? { secondFactor } : {}),
      },
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
    const user = await this.ownUser(auth);
    await this.checkPassword(user, dto.currentPassword, origin);
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

  async twoFactorStatus(auth: AuthContext): Promise<TwoFactorStatus> {
    return this.twoFactor.status(await this.ownUser(auth));
  }

  /** C-189: a new secret to scan; the password proves it is the owner. */
  async beginTwoFactorSetup(
    auth: AuthContext,
    password: string,
    origin: RequestOrigin,
  ): Promise<TwoFactorSetupResponse> {
    const user = await this.ownUser(auth);
    await this.checkPassword(user, password, origin);
    return this.twoFactor.beginSetup(user);
  }

  /**
   * C-189: turns two-factor sign-in on with a code from the offered secret and
   * ends every other session of the caller's — they signed in with the
   * password alone. Returns the recovery codes, shown this once.
   */
  async enableTwoFactor(
    auth: AuthContext,
    code: string,
    origin: RequestOrigin,
  ): Promise<string[]> {
    const user = await this.ownUser(auth);
    const recoveryCodes = await this.twoFactor.enable(user, code);
    if (!recoveryCodes) throw invalidCode(403);
    await this.sessions.revokeAll(user.id, auth.sessionId);
    await this.audit.record({
      actor: userActor(user.id),
      origin,
      action: 'auth.two_factor_enable',
      target: { type: 'user', id: user.id },
      result: 'ok',
    });
    return recoveryCodes;
  }

  /** C-189: turns two-factor sign-in off — the password and a current code. */
  async disableTwoFactor(
    auth: AuthContext,
    dto: TwoFactorConfirmDto,
    origin: RequestOrigin,
  ): Promise<void> {
    const user = await this.enrolledUser(auth);
    if (await this.twoFactor.requiredFor(user)) {
      throw authError(
        403,
        AUTH_ERROR.twoFactorRequiredByPolicy,
        'This server requires two-factor sign-in for administrators',
      );
    }
    await this.checkPassword(user, dto.password, origin, true);
    await this.checkCode(user, dto.code, origin);
    await this.twoFactor.disable(user.id);
    await this.audit.record({
      actor: userActor(user.id),
      origin,
      action: 'auth.two_factor_disable',
      target: { type: 'user', id: user.id },
      result: 'ok',
    });
  }

  /** C-189: a new set of recovery codes — the password and a current code. */
  async regenerateRecoveryCodes(
    auth: AuthContext,
    dto: TwoFactorConfirmDto,
    origin: RequestOrigin,
  ): Promise<string[]> {
    const user = await this.enrolledUser(auth);
    await this.checkPassword(user, dto.password, origin, true);
    await this.checkCode(user, dto.code, origin);
    const recoveryCodes = await this.twoFactor.regenerateRecoveryCodes(user.id);
    await this.audit.record({
      actor: userActor(user.id),
      origin,
      action: 'auth.two_factor_recovery_codes',
      target: { type: 'user', id: user.id },
      result: 'ok',
    });
    return recoveryCodes;
  }

  private ownUser(auth: AuthContext): Promise<User> {
    return this.prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } });
  }

  private async enrolledUser(auth: AuthContext): Promise<User> {
    const user = await this.ownUser(auth);
    if (!user.totpEnabledAt) {
      throw authError(
        409,
        AUTH_ERROR.twoFactorNotEnabled,
        'Two-factor sign-in is off',
      );
    }
    return user;
  }

  /**
   * The caller's own password, on the login counter (C-109): a stolen session
   * guesses no faster than a stranger.
   */
  private async checkPassword(
    user: User,
    password: string,
    origin: RequestOrigin,
    codeFollows = false,
  ): Promise<void> {
    const wait = await this.throttle.waitMs(user.email, origin.ip);
    if (wait > 0) throw sourceThrottled(wait);
    if (!(await verifyPassword(user.passwordHash, password))) {
      await this.countFailure(user.email, origin, user.id);
      throw authError(
        403,
        AUTH_ERROR.invalidCredentials,
        'Current password is wrong',
      );
    }
    // With a code still to check, a right password must not reset the wait.
    if (!codeFollows) await this.throttle.clear(user.email, origin.ip);
  }

  /** A second factor on the same counter; spends it when it is right. */
  private async checkCode(
    user: User,
    code: string,
    origin: RequestOrigin,
  ): Promise<void> {
    if (!(await this.twoFactor.verify(user, code))) {
      await this.countFailure(user.email, origin, user.id);
      throw invalidCode(403);
    }
    await this.throttle.clear(user.email, origin.ip);
  }
}
