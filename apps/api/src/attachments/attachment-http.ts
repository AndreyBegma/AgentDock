import {
  type AttachmentErrorBody,
  attachmentDisposition,
  attachmentSafeName,
} from '@nautelle/shared';
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  PayloadTooLargeException,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { attachmentRefused } from './attachment-error';
import type { AttachmentContent } from './attachments.service';

/** RFC 5987 `filename*`: UTF-8, percent-encoded beyond the attr-chars. */
const extValue = (name: string): string =>
  encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * `Content-Disposition` with the display name: an ASCII fallback built like
 * the safe name (no quote, no separator) and the exact name in `filename*`.
 */
export const contentDisposition = (
  type: 'inline' | 'attachment',
  name: string,
): string =>
  `${type}; filename="${attachmentSafeName(name)}"; filename*=UTF-8''${extValue(name)}`;

/**
 * D8: the bytes with the headers every content response carries — nosniff
 * and no shared caching always; raster images inline; everything else a
 * download that a browser opening it anyway runs sandboxed.
 */
export const sendAttachment = (
  res: Response,
  content: AttachmentContent,
): StreamableFile => {
  const disposition = attachmentDisposition(content.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=0');
  if (disposition === 'attachment') {
    res.setHeader('Content-Security-Policy', 'sandbox');
  }
  return new StreamableFile(content.stream, {
    type: content.mime,
    length: content.size,
    disposition: contentDisposition(disposition, content.name),
  });
};

/**
 * D4: multer stops an upload over `ATTACHMENT_MAX_BYTES` with a 413; the
 * contract's answer is 422 `attachment_error` `too_large`.
 */
@Catch(PayloadTooLargeException)
export class UploadTooLargeFilter implements ExceptionFilter {
  catch(_error: PayloadTooLargeException, host: ArgumentsHost): void {
    const failure = attachmentRefused(
      'too_large',
      'The file is larger than an attachment may be',
    );
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(failure.statusCode)
      .json(failure.getResponse() as AttachmentErrorBody);
  }
}
