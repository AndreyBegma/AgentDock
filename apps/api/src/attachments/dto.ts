import {
  ATTACHMENTS_PER_CARD_MAX,
  type ClaimAttachmentsRequest,
} from '@agentdock/shared';
import { applyDecorators } from '@nestjs/common';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsString,
  Matches,
} from 'class-validator';

/** `attachmentIdSchema`: a cuid, a plain token, never a path. */
export const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * #309 D3: pending uploads to claim — at most `ATTACHMENTS_PER_CARD_MAX`,
 * distinct, each an attachment id. Whether each one may be claimed is the
 * service's (422 `attachment_error` `not_claimable`).
 */
export const AttachmentIds = (): PropertyDecorator =>
  applyDecorators(
    IsArray(),
    ArrayMaxSize(ATTACHMENTS_PER_CARD_MAX),
    ArrayUnique(),
    IsString({ each: true }),
    Matches(ATTACHMENT_ID_PATTERN, {
      each: true,
      message: 'each attachment id must match ^[A-Za-z0-9_-]{1,64}$',
    }),
  );

/** `POST /board/cards/:number/attachments`. */
export class ClaimAttachmentsDto implements ClaimAttachmentsRequest {
  @AttachmentIds()
  @ArrayMinSize(1)
  attachmentIds!: string[];
}
