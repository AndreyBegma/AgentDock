/**
 * Limits of board card attachments (issue #309 D4, ADR-0031). Each limit has
 * its own refusal code (`ATTACHMENT_REFUSAL`).
 */

/** D4: one file, in bytes (`too_large`). */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** D4: attachments of one card, its rounds' feedback included (`too_many`). */
export const ATTACHMENTS_PER_CARD_MAX = 20;

/**
 * D4: the default of `ATTACHMENTS_PROJECT_QUOTA_BYTES`, the bytes one project
 * may store (`quota_exceeded`).
 */
export const ATTACHMENTS_PROJECT_QUOTA_DEFAULT_BYTES = 1024 * 1024 * 1024;

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
