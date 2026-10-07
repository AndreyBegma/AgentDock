import {
  AUTH_ERROR,
  type LoginDeniedReason,
  type PublicUser,
} from '@agentdock/shared';
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
import { authError } from './auth-error';
import type { AuthContext } from './auth-request';
import type { ChangePasswordDto, LoginDto, RegisterDto } from './dto';
import { hashPassword, verifyPassword } from './password';
import { type IssuedSession, SessionService } from './session.service';
import { toPublicUser } from './user-mapper';

export const MAX_FAILED_LOGINS = 10;
export const LOCKOUT_MS = 15 * 60_000;

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
   * Wrong email, wrong password, a locked account and a rejected or disabled
   * account all fail the same way (spec D8, D9). Only a correct password on a
   * pending account says so, because it proves the caller owns the account.
   */
  async login(dto: LoginDto, origin: RequestOrigin): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    const passwordOk = await verifyPassword(
      user?.passwordHash ?? null,
      dto.password,
    );
    // Every refusal is recorded against the email, never the account: the
    // record must not tell an auditor more than the response told the caller.
    const deny = async (reason: LoginDeniedReason, error: HttpException) => {
      await this.audit.record({
        actor: ANONYMOUS_ACTOR,
        origin,
        action: 'auth.login',
        target: { type: 'email', id: dto.email },
        result: 'denied',
        meta: { reason },
      });
      return error;
    };
    if (!user) throw await deny('invalid_credentials', invalidCredentials());

    const locked = user.lockedUntil !== null && user.lockedUntil > new Date();
    if (locked) throw await deny('locked', invalidCredentials());

    if (!passwordOk) {
      await this.recordFailure(user.id);
      throw await deny('invalid_credentials', invalidCredentials());
    }

    if (user.failedLoginCount > 0 || user.lockedUntil !== null) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil: null },
      });
    }
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

  private async recordFailure(userId: string): Promise<void> {
    const { failedLoginCount } = await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    if (failedLoginCount >= MAX_FAILED_LOGINS) {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          failedLoginCount: 0,
          lockedUntil: new Date(Date.now() + LOCKOUT_MS),
        },
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
    if (!(await verifyPassword(user.passwordHash, dto.currentPassword))) {
      throw authError(
        403,
        AUTH_ERROR.invalidCredentials,
        'Current password is wrong',
      );
    }
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
