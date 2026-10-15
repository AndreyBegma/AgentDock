import {
  ATTACHMENT_NAME_MAX,
  ATTACHMENT_SAFE_NAME_MAX,
  ATTACHMENTS_WORKTREE_DIR,
} from './limits';

/**
 * Attachment names (issue #309 D6). The display name is what the person
 * uploaded; every name that reaches a filesystem — on the API's volume or in
 * the worktree — is derived from the attachment id and a safe name, so no path
 * from the user ever reaches a filesystem call.
 */

/** What a name falls back to when nothing of it is left. */
export const ATTACHMENT_FALLBACK_NAME = 'file';

/** The longest extension kept whole when a safe name is cut. */
const EXTENSION_MAX = 16;

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it strips.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * D6: the original name, cut to `ATTACHMENT_NAME_MAX` characters. A client
 * that sends a path keeps only its last segment, and control characters
 * become spaces so the name stays one line.
 */
export const attachmentDisplayName = (original: string): string => {
  const base = original.slice(
    Math.max(original.lastIndexOf('/'), original.lastIndexOf('\\')) + 1,
  );
  const name = [...base.replace(CONTROL, ' ').trim()]
    .slice(0, ATTACHMENT_NAME_MAX)
    .join('')
    .trim();
  return name || ATTACHMENT_FALLBACK_NAME;
};

/**
 * D6: `[A-Za-z0-9._-]` kept, every other character `_`, at most
 * `ATTACHMENT_SAFE_NAME_MAX` characters with the extension kept.
 */
export const attachmentSafeName = (name: string): string => {
  const safe = [...name].map((ch) => (/^[A-Za-z0-9._-]$/.test(ch) ? ch : '_'));
  const text = safe.join('');
  if (!text) return ATTACHMENT_FALLBACK_NAME;
  if (text.length <= ATTACHMENT_SAFE_NAME_MAX) return text;
  const dot = text.lastIndexOf('.');
  const ext =
    dot > 0 && text.length - dot <= EXTENSION_MAX ? text.slice(dot) : '';
  return text.slice(0, ATTACHMENT_SAFE_NAME_MAX - ext.length) + ext;
};

/** D6: `<attachmentId>-<safe name>` — the file's name on disk and in the worktree. */
export const attachmentFileName = (id: string, name: string): string =>
  `${id}-${attachmentSafeName(name)}`;

/** D9/D10: the attachment's path relative to the card's worktree. */
export const attachmentWorktreePath = (id: string, name: string): string =>
  `${ATTACHMENTS_WORKTREE_DIR}/${attachmentFileName(id, name)}`;
