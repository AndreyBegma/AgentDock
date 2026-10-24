import {
  ATTACHMENT_ERROR,
  type AttachmentErrorBody,
  type AttachmentErrorCode,
  type AttachmentRefusal,
} from '@nautelle/shared';
import { HttpException } from '@nestjs/common';

/**
 * An HTTP error of the attachment routes (#309), shaped like every other API
 * error. A refusal carries its `code` beside `error: 'attachment_error'` —
 * the same body the board routes send when a create or feedback claim is
 * refused (`BOARD_ERROR.attachmentError`).
 */
export class AttachmentFailure extends HttpException {
  constructor(
    readonly statusCode: number,
    readonly error: AttachmentErrorCode,
    message: string,
    readonly code?: AttachmentRefusal,
  ) {
    const body: AttachmentErrorBody = {
      statusCode,
      error,
      message,
      ...(code ? { code } : {}),
    };
    super(body, statusCode);
  }
}

/** 422 `attachment_error` with its refusal `code` (D4, D5, D3). */
export const attachmentRefused = (
  code: AttachmentRefusal,
  message: string,
): AttachmentFailure =>
  new AttachmentFailure(422, ATTACHMENT_ERROR.attachmentError, message, code);

export const attachmentNotFound = (): AttachmentFailure =>
  new AttachmentFailure(404, ATTACHMENT_ERROR.notFound, 'Attachment not found');

/**
 * ADR-0090: 416 — a `Range` no byte of the file satisfies. The route sends
 * `Content-Range: bytes *` with the file's `size`.
 */
export class AttachmentRangeFailure extends AttachmentFailure {
  constructor(readonly size: number) {
    super(
      416,
      ATTACHMENT_ERROR.rangeNotSatisfiable,
      'The requested range is past the end of the attachment',
    );
  }
}
