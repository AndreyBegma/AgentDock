/**
 * Limits of board card attachments (issue #309 D4, ADR-0031). Each limit has
 * its own refusal code (`ATTACHMENT_REFUSAL`).
 */

import { type AttachmentMime, isAttachmentVideo } from './types';

/** D4: one file, in bytes (`too_large`) — every type but video. */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** ADR-0090 (amends ADR-0031 D4): one video, in bytes (`too_large`). */
export const ATTACHMENT_VIDEO_MAX_BYTES = 100 * 1024 * 1024;

/**
 * ADR-0090: the largest upload of any type — what the upload stream is cut
 * at, before its type is known. The type's own limit is checked after.
 */
export const ATTACHMENT_UPLOAD_MAX_BYTES = Math.max(
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_VIDEO_MAX_BYTES,
);

/** ADR-0090: the size limit of one file of type `mime`. */
export const attachmentMaxBytes = (mime: AttachmentMime): number =>
  isAttachmentVideo(mime) ? ATTACHMENT_VIDEO_MAX_BYTES : ATTACHMENT_MAX_BYTES;

/**
 * D4: attachments of one card, its rounds' feedback included (`too_many`).
 * ADR-0090: videos do not count.
 */
export const ATTACHMENTS_PER_CARD_MAX = 20;

/**
 * D4: the default of `ATTACHMENTS_PROJECT_QUOTA_BYTES`, the bytes one project
 * may store (`quota_exceeded`).
 */
export const ATTACHMENTS_PROJECT_QUOTA_DEFAULT_BYTES = 1024 * 1024 * 1024;

/**
 * #156: the default of `ATTACHMENTS_USER_PENDING_BYTES`, the bytes of unclaimed,
 * unexpired uploads one user may hold (`pending_exceeded`) — so one member's
 * uploads no card claims cannot fill the project's quota.
 */
export const ATTACHMENTS_USER_PENDING_DEFAULT_BYTES = 256 * 1024 * 1024;

/** D6: the display name — the original name — is cut to this many characters. */
export const ATTACHMENT_NAME_MAX = 200;

/** D6: the safe name on disk and in the worktree, extension kept. */
export const ATTACHMENT_SAFE_NAME_MAX = 80;

/** D3: a pending upload no card claimed is swept this long after it was uploaded. */
export const ATTACHMENT_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/** D9: where the runner writes a card's attachments, relative to its worktree. */
export const ATTACHMENTS_WORKTREE_DIR = '.agentdock/attachments';

/** D9: the directory the runner git-excludes in the worktree. */
export const AGENTDOCK_WORKTREE_DIR = '.agentdock';
