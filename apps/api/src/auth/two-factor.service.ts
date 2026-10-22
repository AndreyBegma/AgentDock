import {
  AUTH_ERROR,
  RECOVERY_CODE_COUNT,
  TWO_FACTOR_ADMIN_SETTING_KEY,
  type TwoFactorSetupResponse,
  type TwoFactorStatus,
} from '@nautelle/shared';
import { Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { SecretCipher } from '../common/crypto';
import { PrismaService } from '../database/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { authError } from './auth-error';
import {
  generateRecoveryCode,
  generateTotpSecret,
  hashRecoveryCode,
  isTotpCode,
  matchTotpStep,
  otpauthUrl,
} from './totp';

/** The issuer authenticator apps list the account under. */
const ISSUER = 'Nautelle';

/** How a code was accepted. */
export type SecondFactor = 'totp' | 'recovery_code';

const unavailable = () =>
  authError(
    503,
    AUTH_ERROR.twoFactorUnavailable,
    'APP_ENCRYPTION_KEY is not configured (32 random bytes, base64); two-factor sign-in needs it to store its secret',
  );

/**
 * TOTP two-factor sign-in (C-189, RFC 6238). The secret is sealed with
 * `APP_ENCRYPTION_KEY`; recovery codes are stored as SHA-256 hashes and each
 * works once. Proving the password and counting failures is the caller's job
 * (`AuthService`): this service only checks and stores the second factor.
 */
@Injectable()
export class TwoFactorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: SecretCipher,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  /** Whether the instance requires every admin to use a second factor. */
  async requiredForAdmins(): Promise<boolean> {
    return (await this.settings.get(TWO_FACTOR_ADMIN_SETTING_KEY)) === true;
  }

  async setRequiredForAdmins(
    required: boolean,
    userId: string,
    ctx: AuditContext,
  ): Promise<boolean> {
    const before = await this.requiredForAdmins();
    await this.settings.set(TWO_FACTOR_ADMIN_SETTING_KEY, required, userId);
    await this.audit.record({
      ...ctx,
      action: 'settings.two_factor',
      target: { type: 'setting', id: TWO_FACTOR_ADMIN_SETTING_KEY },
      before: { requiredForAdmins: before },
      after: { requiredForAdmins: required },
      result: 'ok',
    });
    return required;
  }

  /** Whether the instance requires a second factor of this account. */
  async requiredFor(user: Pick<User, 'role'>): Promise<boolean> {
    return user.role === 'admin' && (await this.requiredForAdmins());
  }

  async status(user: User): Promise<TwoFactorStatus> {
    const enabled = user.totpEnabledAt !== null;
    return {
      enabled,
      required: await this.requiredFor(user),
      recoveryCodesLeft: enabled
        ? await this.prisma.userRecoveryCode.count({
            where: { userId: user.id, usedAt: null },
          })
        : 0,
    };
  }

  /**
   * Offers a new secret. It replaces any earlier unconfirmed one and is not
   * in force until `enable` sees a code from it.
   */
  async beginSetup(user: User): Promise<TwoFactorSetupResponse> {
    if (user.totpEnabledAt) {
      throw authError(
        409,
        AUTH_ERROR.twoFactorAlreadyEnabled,
        'Two-factor sign-in is already on',
      );
    }
    if (!this.cipher.available) throw unavailable();
    const secret = generateTotpSecret();
    await this.prisma.user.update({
      where: { id: user.id },
      data: { totpPendingSecret: this.cipher.encrypt(secret) },
    });
    return { secret, otpauthUrl: otpauthUrl(ISSUER, user.email, secret) };
  }

  /**
   * Turns two-factor sign-in on once `code` comes from the offered secret, and
   * returns the recovery codes — the only time they are shown. Null: the code
   * does not match.
   */
  async enable(user: User, code: string): Promise<string[] | null> {
    if (user.totpEnabledAt) {
      throw authError(
        409,
        AUTH_ERROR.twoFactorAlreadyEnabled,
        'Two-factor sign-in is already on',
      );
    }
    if (!user.totpPendingSecret) {
      throw authError(
        409,
        AUTH_ERROR.twoFactorNoSetup,
        'Start the setup first: no secret is waiting for a code',
      );
    }
    const secret = this.open(user.totpPendingSecret);
    const step = matchTotpStep(secret, code, new Date(), null);
    if (step === null) return null;

    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      generateRecoveryCode(),
    );
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          totpSecret: user.totpPendingSecret,
          totpPendingSecret: null,
          totpEnabledAt: new Date(),
          totpLastStep: step,
        },
      }),
      ...this.replaceRecoveryCodes(user.id, codes),
    ]);
    return codes;
  }

  /** Turns two-factor sign-in off and forgets the secret and every recovery code. */
  async disable(userId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          totpSecret: null,
          totpPendingSecret: null,
          totpEnabledAt: null,
          totpLastStep: null,
        },
      }),
      this.prisma.userRecoveryCode.deleteMany({ where: { userId } }),
    ]);
  }

  /** A new set of recovery codes; the old ones stop working. */
  async regenerateRecoveryCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      generateRecoveryCode(),
    );
    await this.prisma.$transaction(this.replaceRecoveryCodes(userId, codes));
    return codes;
  }

  /**
   * Checks a second factor of an enrolled account and spends it: a TOTP code
   * moves `totpLastStep` past its step, a recovery code is marked used. Both
   * are conditional updates, so two requests racing with one code cannot both
   * win. Null: wrong, expired or already used.
   */
  async verify(user: User, code: string): Promise<SecondFactor | null> {
    if (!user.totpEnabledAt || !user.totpSecret) return null;
    if (isTotpCode(code)) {
      const step = matchTotpStep(
        this.open(user.totpSecret),
        code,
        new Date(),
        user.totpLastStep,
      );
      if (step === null) return null;
      const { count } = await this.prisma.user.updateMany({
        where: {
          id: user.id,
          OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }],
        },
        data: { totpLastStep: step },
      });
      return count === 1 ? 'totp' : null;
    }
    const { count } = await this.prisma.userRecoveryCode.updateMany({
      where: {
        userId: user.id,
        codeHash: hashRecoveryCode(code),
        usedAt: null,
      },
      data: { usedAt: new Date() },
    });
    return count === 1 ? 'recovery_code' : null;
  }

  private replaceRecoveryCodes(userId: string, codes: string[]) {
    return [
      this.prisma.userRecoveryCode.deleteMany({ where: { userId } }),
      this.prisma.userRecoveryCode.createMany({
        data: codes.map((code) => ({
          userId,
          codeHash: hashRecoveryCode(code),
        })),
      }),
    ];
  }

  private open(sealed: string): string {
    if (!this.cipher.available) throw unavailable();
    return this.cipher.decrypt(sealed);
  }
}
