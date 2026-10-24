import { z } from 'zod';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_NAME_MAX } from './limits';
import { ATTACHMENT_MIMES, type AttachmentMime } from './types';

/**
 * HTTP and runner contracts of board card attachments (issue #309, ADR-0031).
 * Browser routes are under `/projects/:projectId`, behind the project guard;
 * the runner reads `/runner/attachments/:id` with its runner token (D9).
 */

/** `attachments.id`: a cuid, a plain token, never a path. */
export const attachmentIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'must match ^[A-Za-z0-9_-]{1,64}$');

/** Lower-case hex SHA-256 of the bytes. */
export const attachmentSha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'must be 64 lower-case hex characters');

const attachmentNameSchema = z
  .string()
  .min(1)
  .refine((t) => [...t].length <= ATTACHMENT_NAME_MAX, {
    message: `must be at most ${ATTACHMENT_NAME_MAX} characters`,
  })
  .refine((t) => !t.includes('\u0000'), { message: 'must not contain NUL' });

/**
 * D9: one attachment as `card.run` lists it. The runner derives the file name
 * from `id` and `name` (`attachmentFileName`) and checks `size` and `sha256`
 * against what it downloaded.
 */
export const attachmentRefSchema = z.strictObject({
  id: attachmentIdSchema,
  /** The display name (D6). */
  name: attachmentNameSchema,
  mime: z.enum(ATTACHMENT_MIMES),
  size: z.number().int().nonnegative().max(ATTACHMENT_MAX_BYTES),
  sha256: attachmentSha256Schema,
});
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

/**
 * D10: an attachment as a round's snapshot and `cardChange` know it — enough
 * to name its worktree path.
 */
export const cardAttachmentBriefSchema = z.object({
  id: attachmentIdSchema,
  name: attachmentNameSchema,
  mime: z.enum(ATTACHMENT_MIMES),
});
export type CardAttachmentBrief = z.infer<typeof cardAttachmentBriefSchema>;

/**
 * D10: `board_card_rounds.cardAttachments` — the card's attachments when the
 * round's prompt was built, beside the #273 text snapshot.
 */
export const cardAttachmentSnapshotSchema = z.array(cardAttachmentBriefSchema);

/** One attachment, as the card sheet and the feedback rounds show it. */
export interface AttachmentView {
  id: string;
  /** The display name (D6). */
  name: string;
  /** Detected from the content (D5). */
  mime: AttachmentMime;
  /** Bytes. */
  size: number;
  createdAt: string;
  /** `null` once the uploader is deleted. */
  uploaderId: string | null;
  uploaderName: string | null;
  /** The feedback round it came with; `null` for an attachment on the card itself. */
  roundId: string | null;
  /**
   * The API path of the bytes (`attachmentContentPath`), read with the
   * session cookie. Never a public or signed URL (D8).
   */
  contentUrl: string;
}

/** D8: `GET` this API path for the bytes; relative to the API's base URL. */
export const attachmentContentPath = (projectId: string, id: string): string =>
  `/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(id)}/content`;

/** D9: the runner's download path, read with `Authorization: Bearer <runner token>`. */
export const runnerAttachmentPath = (id: string): string =>
  `/runner/attachments/${encodeURIComponent(id)}`;

/** D12: the multipart field `POST /attachments` reads the file from. */
export const ATTACHMENT_UPLOAD_FIELD = 'file';

/**
 * `POST /board/cards/:number/attachments` (operator): claims pending uploads
 * onto an existing card. Creating a card and feedback carry `attachmentIds`
 * in their own bodies.
 */
export interface ClaimAttachmentsRequest {
  attachmentIds: string[];
}

/**
 * Why an upload or a claim is refused — the `code` of a 422 `attachment_error`
 * (413 for `pending_exceeded`).
 */
export const ATTACHMENT_REFUSAL = {
  /** Over `attachmentMaxBytes` of its type (ADR-0089). */
  tooLarge: 'too_large',
  /** Not in the allowlist by its content (D5). */
  unsupportedType: 'unsupported_type',
  /** The card would hold more than `ATTACHMENTS_PER_CARD_MAX`. */
  tooMany: 'too_many',
  /** The project would store more than `ATTACHMENTS_PROJECT_QUOTA_BYTES`. */
  quotaExceeded: 'quota_exceeded',
  /**
   * #156: the uploader's unclaimed uploads would hold more than
   * `ATTACHMENTS_USER_PENDING_BYTES` — sent with 413, not 422.
   */
  pendingExceeded: 'pending_exceeded',
  /** Not pending, from another project, or uploaded by someone else (D3). */
  notClaimable: 'not_claimable',
} as const;
export type AttachmentRefusal =
  (typeof ATTACHMENT_REFUSAL)[keyof typeof ATTACHMENT_REFUSAL];

/** Stable codes in the `error` field of an attachment route's error body. */
export const ATTACHMENT_ERROR = {
  notFound: 'not_found',
  /** 422, with `code`. */
  attachmentError: 'attachment_error',
  /** 409: delete of an attachment on a card in Completed. */
  cardCompleted: 'card_completed',
  /** ADR-0089: 416, a `Range` past the end of the file. */
  rangeNotSatisfiable: 'range_not_satisfiable',
} as const;
export type AttachmentErrorCode =
  (typeof ATTACHMENT_ERROR)[keyof typeof ATTACHMENT_ERROR];

export interface AttachmentErrorBody {
  statusCode: number;
  error: AttachmentErrorCode;
  message: string;
  /** `attachment_error` only. */
  code?: AttachmentRefusal;
}
