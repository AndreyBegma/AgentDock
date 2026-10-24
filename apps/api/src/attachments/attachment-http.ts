import { pipeline } from 'node:stream/promises';
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
import { AttachmentRangeFailure, attachmentRefused } from './attachment-error';
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
const setSafetyHeaders = (
  res: Response,
  disposition: 'inline' | 'attachment',
): void => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=0');
  if (disposition === 'attachment') {
    res.setHeader('Content-Security-Policy', 'sandbox');
  }
};

export const sendAttachment = (
  res: Response,
  content: AttachmentContent,
): StreamableFile => {
  const disposition = attachmentDisposition(content.mime);
  setSafetyHeaders(res, disposition);
  return new StreamableFile(content.stream, {
    type: content.mime,
    length: content.size,
    disposition: contentDisposition(disposition, content.name),
  });
};

/**
 * ADR-0089: `sendAttachment` for a route that reads `Range` — 206 with
 * `Content-Range` for a range, 200 for the whole file, `Accept-Ranges` on
 * both. Written by hand: Nest's reply would set 200 over a 206.
 */
export const streamAttachment = async (
  res: Response,
  content: AttachmentContent,
): Promise<void> => {
  const disposition = attachmentDisposition(content.mime);
  setSafetyHeaders(res, disposition);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', content.mime);
  res.setHeader(
    'Content-Disposition',
    contentDisposition(disposition, content.name),
  );
  const { range } = content;
  if (range) {
    res.status(206);
    res.setHeader(
      'Content-Range',
      `bytes ${range.start}-${range.end}/${content.size}`,
    );
    res.setHeader('Content-Length', String(range.end - range.start + 1));
  } else {
    res.status(200);
    res.setHeader('Content-Length', String(content.size));
  }
  try {
    await pipeline(content.stream, res);
  } catch {
    // A player that seeks closes the response mid-file; nothing is left to
    // answer once the headers are out.
    res.destroy();
  }
};

/** ADR-0089: 416 for a `Range` past the end, with the file's size. */
export const sendUnsatisfiable = (
  res: Response,
  failure: AttachmentRangeFailure,
): void => {
  res
    .status(failure.statusCode)
    .setHeader('Content-Range', `bytes */${failure.size}`)
    .setHeader('Accept-Ranges', 'bytes')
    .json(failure.getResponse() as AttachmentErrorBody);
};

/**
 * D4: multer stops an upload over `ATTACHMENT_UPLOAD_MAX_BYTES` with a 413; the
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
