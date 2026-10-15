import { resolve } from 'node:path';
import { ATTACHMENTS_PROJECT_QUOTA_DEFAULT_BYTES } from '@agentdock/shared';
import type { ConfigService } from '@nestjs/config';

export const ATTACHMENTS_OPTIONS = Symbol('ATTACHMENTS_OPTIONS');

export interface AttachmentsOptions {
  /** D2: where the bytes live, absolute; `<projectId>/<attachmentId>` below it. */
  dir: string;
  /** D4: bytes one project may store, pending uploads included. */
  projectQuotaBytes: number;
  /** Whether the daily sweep's worker runs on this instance. */
  sweepEnabled: boolean;
}

export const ATTACHMENTS_DIR_DEFAULT = './data/attachments';

const quotaOf = (value: string | undefined): number => {
  const raw = value?.trim();
  if (!raw) return ATTACHMENTS_PROJECT_QUOTA_DEFAULT_BYTES;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(
      'ATTACHMENTS_PROJECT_QUOTA_BYTES must be a whole number of bytes',
    );
  }
  return Number(raw);
};

/** `ATTACHMENTS_DIR` and `ATTACHMENTS_PROJECT_QUOTA_BYTES` (#309 D2, D4). */
export const attachmentsOptions = (
  config: ConfigService,
): AttachmentsOptions => ({
  dir: resolve(
    config.get<string>('ATTACHMENTS_DIR')?.trim() || ATTACHMENTS_DIR_DEFAULT,
  ),
  projectQuotaBytes: quotaOf(
    config.get<string>('ATTACHMENTS_PROJECT_QUOTA_BYTES'),
  ),
  // Every e2e suite boots the whole app; tests call the sweep themselves.
  sweepEnabled:
    config.get<string>('APP_ENV') !== 'test' &&
    Boolean(config.get<string>('REDIS_URL')?.trim()),
});
