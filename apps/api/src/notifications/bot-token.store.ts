import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit';
import type { AuditContext } from '../audit/audit.types';
import { SecretCipher, SecretCipherError } from '../common/crypto';
import { PrismaService } from '../database/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { encryptionKeyMissing } from './notification-error';

/** The `settings` row of the Telegram bot (spec 22 D8). */
export const TELEGRAM_BOT_TOKEN_SETTING_KEY = 'telegram.botToken';

/** What is stored: the token sealed by `SecretCipher`, never the token. */
interface StoredBotToken {
  ciphertext: string;
  botUsername: string;
}

const isStored = (value: unknown): value is StoredBotToken =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as StoredBotToken).ciphertext === 'string' &&
  typeof (value as StoredBotToken).botUsername === 'string';

export interface BotTokenStatus {
  configured: boolean;
  botUsername: string | null;
  /** `APP_ENCRYPTION_KEY` is set and usable. */
  encryptionAvailable: boolean;
}

export type BotTokenRead =
  | { ok: true; token: string; botUsername: string }
  | {
      ok: false;
      reason: 'not_configured' | 'encryption_key_missing' | 'undecryptable';
    };

/**
 * Storage of the Telegram bot token (spec 22 D8). The token is sealed with
 * `APP_ENCRYPTION_KEY` before it is written, is returned only by `read()` for
 * the Telegram module's own HTTP calls, and never appears in a response, a
 * log line or an audit record — audits carry `{ configured, botUsername }`.
 * Verifying the token (`getMe`) is the caller's job, before `set`.
 */
@Injectable()
export class BotTokenStore {
  private readonly logger = new Logger(BotTokenStore.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly cipher: SecretCipher,
    private readonly audit: AuditService,
  ) {}

  async status(): Promise<BotTokenStatus> {
    const stored = await this.stored();
    return {
      configured: stored !== null,
      botUsername: stored?.botUsername ?? null,
      encryptionAvailable: this.cipher.available,
    };
  }

  /** The token for a Telegram API call. */
  async read(): Promise<BotTokenRead> {
    const stored = await this.stored();
    if (!stored) return { ok: false, reason: 'not_configured' };
    if (!this.cipher.available) {
      return { ok: false, reason: 'encryption_key_missing' };
    }
    try {
      return {
        ok: true,
        token: this.cipher.decrypt(stored.ciphertext),
        botUsername: stored.botUsername,
      };
    } catch (error) {
      if (!(error instanceof SecretCipherError)) throw error;
      // The message is fixed text; it carries neither key nor token.
      this.logger.error(`stored Telegram bot token unusable: ${error.message}`);
      return { ok: false, reason: 'undecryptable' };
    }
  }

  /**
   * Seals and stores a verified token. 409 `encryption_key_missing` without a
   * usable key: a secret is never stored in the clear.
   */
  async set(
    token: string,
    botUsername: string,
    userId: string,
    ctx: AuditContext,
  ): Promise<BotTokenStatus> {
    if (!this.cipher.available) throw encryptionKeyMissing();
    const before = await this.status();
    const value: StoredBotToken = {
      ciphertext: this.cipher.encrypt(token),
      botUsername,
    };
    await this.settings.set(
      TELEGRAM_BOT_TOKEN_SETTING_KEY,
      { ...value },
      userId,
    );
    await this.audit.record({
      ...ctx,
      action: 'telegram.configure',
      target: { type: 'setting', id: TELEGRAM_BOT_TOKEN_SETTING_KEY },
      before: {
        configured: before.configured,
        botUsername: before.botUsername,
      },
      after: { configured: true, botUsername },
      result: 'ok',
    });
    return this.status();
  }

  async clear(ctx: AuditContext): Promise<BotTokenStatus> {
    const before = await this.status();
    await this.prisma.setting.deleteMany({
      where: { key: TELEGRAM_BOT_TOKEN_SETTING_KEY },
    });
    if (before.configured) {
      await this.audit.record({
        ...ctx,
        action: 'telegram.clear',
        target: { type: 'setting', id: TELEGRAM_BOT_TOKEN_SETTING_KEY },
        before: { configured: true, botUsername: before.botUsername },
        after: { configured: false },
        result: 'ok',
      });
    }
    return this.status();
  }

  private async stored(): Promise<StoredBotToken | null> {
    const value = await this.settings.get(TELEGRAM_BOT_TOKEN_SETTING_KEY);
    return isStored(value) ? value : null;
  }
}
