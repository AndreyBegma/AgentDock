import type { KeyObject } from 'node:crypto';
import { GITHUB_APP_ERROR } from '@agentdock/shared';
import { Injectable, Logger } from '@nestjs/common';
import type { GitHubApp } from '@prisma/client';
import { SecretCipher } from '../common/crypto';
import { PrismaService } from '../database/prisma.service';
import { githubAppError } from './github-app-error';
import { parseAppPrivateKey } from './github-jwt';

/** The single row's id: one App per instance. */
export const GITHUB_APP_ROW_ID = 'app';

/** Plaintext secrets to seal into the row. */
export interface GitHubAppSecrets {
  privateKey: string;
  webhookSecret: string;
  clientSecret: string | null;
}

export interface SealedSecrets {
  privateKey: string;
  webhookSecret: string;
  clientSecret: string | null;
}

/**
 * The App row and its secrets at rest (D3): sealed with #22's `SecretCipher`
 * (AES-256-GCM, `APP_ENCRYPTION_KEY`). Plaintext leaves this class only to
 * sign a JWT or verify a delivery, and is never logged.
 */
@Injectable()
export class GitHubAppStore {
  private readonly logger = new Logger(GitHubAppStore.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: SecretCipher,
  ) {}

  load(): Promise<GitHubApp | null> {
    return this.prisma.gitHubApp.findUnique({
      where: { id: GITHUB_APP_ROW_ID },
    });
  }

  async require(): Promise<GitHubApp> {
    const app = await this.load();
    if (!app)
      throw githubAppError(
        404,
        GITHUB_APP_ERROR.notRegistered,
        'No GitHub App is registered',
      );
    return app;
  }

  /** 409 `encryption_key_missing` without a usable key (D3). */
  requireCipher(): void {
    if (!this.cipher.available)
      throw githubAppError(
        409,
        GITHUB_APP_ERROR.encryptionKeyMissing,
        'APP_ENCRYPTION_KEY is not set; the App credentials cannot be stored',
      );
  }

  seal(secrets: GitHubAppSecrets): SealedSecrets {
    this.requireCipher();
    return {
      privateKey: this.cipher.encrypt(secrets.privateKey),
      webhookSecret: this.cipher.encrypt(secrets.webhookSecret),
      clientSecret:
        secrets.clientSecret === null
          ? null
          : this.cipher.encrypt(secrets.clientSecret),
    };
  }

  /** The private key, or null when it cannot be opened or parsed. */
  privateKey(app: GitHubApp): KeyObject | null {
    try {
      return parseAppPrivateKey(this.cipher.decrypt(app.privateKey));
    } catch {
      this.logger.error(
        'the GitHub App private key cannot be opened (APP_ENCRYPTION_KEY missing or changed)',
      );
      return null;
    }
  }

  /** The webhook secret, or null when it cannot be opened: verification fails closed. */
  webhookSecret(app: GitHubApp): string | null {
    try {
      return this.cipher.decrypt(app.webhookSecret);
    } catch {
      this.logger.error(
        'the GitHub App webhook secret cannot be opened (APP_ENCRYPTION_KEY missing or changed)',
      );
      return null;
    }
  }
}
