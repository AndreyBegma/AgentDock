import {
  ATTACHMENT_IMAGE_MIMES,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_REFUSAL,
  ATTACHMENTS_PER_CARD_MAX,
  type AttachmentRefusal,
  type AttachmentView,
  CSRF_COOKIE,
  CSRF_HEADER,
  isAttachmentMime,
} from '@agentdock/shared';
import type { FileRejection } from '@andrewbehma/glass-ui/file-dropzone';

/** Spec "Copy": under every dropzone. */
export const ATTACHMENT_NOTE =
  'Every member of this project can open attachments. Do not attach secrets.';

/** What the dropzone's picker offers; the server decides by content (D5). */
export const ATTACHMENT_ACCEPT: string[] = [];

const IMAGE_MIMES: readonly string[] = ATTACHMENT_IMAGE_MIMES;

export const isImageMime = (mime: string): boolean =>
  IMAGE_MIMES.includes(mime);

/** Each refusal code has its own sentence (spec "Refusals"). */
export const REFUSAL_TEXT: Record<AttachmentRefusal, string> = {
  [ATTACHMENT_REFUSAL.tooLarge]: `That file is over ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MiB.`,
  [ATTACHMENT_REFUSAL.unsupportedType]:
    'That file type is not accepted. Use PNG, JPEG, GIF, WebP, PDF or a text file (.txt .md .log .csv .json .diff .patch).',
  [ATTACHMENT_REFUSAL.tooMany]: `A card holds at most ${ATTACHMENTS_PER_CARD_MAX} attachments, feedback included.`,
  [ATTACHMENT_REFUSAL.quotaExceeded]:
    'This project has used up its attachment storage. Remove some attachments first.',
  [ATTACHMENT_REFUSAL.notClaimable]:
    'That upload can no longer be attached. Upload it again.',
};

const isRefusal = (code: unknown): code is AttachmentRefusal =>
  typeof code === 'string' && code in REFUSAL_TEXT;

/** A failed upload or claim as a sentence: the refusal's own text, else the status. */
export function describeUploadFailure(
  httpStatus: number | undefined,
  body: unknown,
): string {
  const record =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : {};
  if (isRefusal(record.code)) return REFUSAL_TEXT[record.code];
  if (httpStatus === 403) return 'Your role cannot upload attachments.';
  if (httpStatus === 409) return 'This card is completed; its files are fixed.';
  if (httpStatus === 413) return REFUSAL_TEXT[ATTACHMENT_REFUSAL.tooLarge];
  if (httpStatus === undefined) return 'The upload did not reach the server.';
  return 'The upload failed. Try again.';
}

/** Why the dropzone itself turned a file away, before any request. */
export function describeRejection(rejection: FileRejection): string {
  const name = rejection.file.name;
  switch (rejection.reason) {
    case 'too-large':
      return `${name}: ${REFUSAL_TEXT[ATTACHMENT_REFUSAL.tooLarge]}`;
    case 'type':
      return `${name}: ${REFUSAL_TEXT[ATTACHMENT_REFUSAL.unsupportedType]}`;
    case 'too-many':
      return `${name}: ${REFUSAL_TEXT[ATTACHMENT_REFUSAL.tooMany]}`;
  }
}

/** D7: delete own as operator, anyone's as admin. */
export const canRemoveAttachment = (
  attachment: Pick<AttachmentView, 'uploaderId'>,
  user: { id: string; role: string },
): boolean => user.role === 'admin' || attachment.uploaderId === user.id;

/** The browser reads the bytes through the `/api` rewrite, with the cookie (D8). */
export const attachmentHref = (
  attachment: Pick<AttachmentView, 'contentUrl'>,
) => `/api${attachment.contentUrl}`;

/** D12: `POST` target of `useFileUpload`. */
export const uploadUrl = (projectId: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/attachments`;

/** The CSRF header every non-GET call carries (see `api()`). */
export function csrfHeaders(cookie: string): Record<string, string> {
  for (const part of cookie.split('; ')) {
    const eq = part.indexOf('=');
    if (part.slice(0, eq) === CSRF_COOKIE) {
      return { [CSRF_HEADER]: decodeURIComponent(part.slice(eq + 1)) };
    }
  }
  return {};
}

/** The `AttachmentView` in a finished upload's response, or `undefined`. */
export function uploadedView(response: unknown): AttachmentView | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  const r = response as Partial<AttachmentView>;
  return typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    typeof r.mime === 'string' &&
    isAttachmentMime(r.mime) &&
    typeof r.size === 'number' &&
    typeof r.contentUrl === 'string'
    ? (r as AttachmentView)
    : undefined;
}

/** Attachments of the card itself and of each feedback round (`roundId`). */
export function splitByRound(attachments: readonly AttachmentView[]): {
  card: AttachmentView[];
  byRound: Map<string, AttachmentView[]>;
} {
  const card: AttachmentView[] = [];
  const byRound = new Map<string, AttachmentView[]>();
  for (const a of attachments) {
    if (a.roundId === null) {
      card.push(a);
    } else {
      byRound.set(a.roundId, [...(byRound.get(a.roundId) ?? []), a]);
    }
  }
  return { card, byRound };
}

/** The card face's count, "1 attachment" / "3 attachments". */
export const attachmentCountLabel = (count: number): string =>
  `${count} attachment${count === 1 ? '' : 's'}`;
