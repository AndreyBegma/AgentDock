import { resolve } from 'node:path';
import {
  ATTACHMENTS_PROJECT_QUOTA_DEFAULT_BYTES,
  ATTACHMENTS_USER_PENDING_DEFAULT_BYTES,
} from '@nautelle/shared';
import type { ConfigService } from '@nestjs/config';

export const ATTACHMENTS_OPTIONS = Symbol('ATTACHMENTS_OPTIONS');

export interface AttachmentsOptions {
  /** D2: where the bytes live, absolute; `<projectId>/<attachmentId>` below it. */
  dir: string;
  /** D4: bytes one project may store, pending uploads included. */
  projectQuotaBytes: number;
  /** #156: bytes of unclaimed, unexpired uploads one user may hold. */
  userPendingBytes: number;
  /** Whether the daily sweep's worker runs on this instance. */
  sweepEnabled: boolean;
}

export const ATTACHMENTS_DIR_DEFAULT = './data/attachments';

const bytesOf = (
  config: ConfigService,
  key: string,
  fallback: number,
): number => {
  const raw = config.get<string>(key)?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`${key} must be a whole number of bytes`);
  }
  return Number(raw);
};

/**
 * `ATTACHMENTS_DIR`, `ATTACHMENTS_PROJECT_QUOTA_BYTES` (#309 D2, D4) and
 * `ATTACHMENTS_USER_PENDING_BYTES` (#156).
 */
export const attachmentsOptions = (
  config: ConfigService,
): AttachmentsOptions => ({
  dir: resolve(
    config.get<string>('ATTACHMENTS_DIR')?.trim() || ATTACHMENTS_DIR_DEFAULT,
  ),
  projectQuotaBytes: bytesOf(
    config,
    'ATTACHMENTS_PROJECT_QUOTA_BYTES',
    ATTACHMENTS_PROJECT_QUOTA_DEFAULT_BYTES,
  ),
  userPendingBytes: bytesOf(
    config,
    'ATTACHMENTS_USER_PENDING_BYTES',
    ATTACHMENTS_USER_PENDING_DEFAULT_BYTES,
  ),
  // Every e2e suite boots the whole app; tests call the sweep themselves.
  sweepEnabled:
    config.get<string>('APP_ENV') !== 'test' &&
    Boolean(config.get<string>('REDIS_URL')?.trim()),
});
