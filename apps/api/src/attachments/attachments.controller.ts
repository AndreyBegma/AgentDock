import {
  ATTACHMENT_UPLOAD_FIELD,
  type AttachmentView,
  BOARD_CHANGED_EVENT,
  type BoardChangedData,
} from '@nautelle/shared';
import {
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AuditCtx } from '../audit';
import type { AuditContext } from '../audit/audit.types';
import { type AuthUser, CurrentUser, Public } from '../auth';
import { LiveService } from '../live/live.service';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
import { attachmentNotFound } from './attachment-error';
import { sendAttachment, UploadTooLargeFilter } from './attachment-http';
import {
  type AttachmentActor,
  AttachmentsService,
  type UploadedAttachment,
} from './attachments.service';
import { ATTACHMENT_ID_PATTERN } from './dto';

/** An attachment id from the path; anything else is no attachment. */
export const attachmentId = (value: string): string => {
  if (!ATTACHMENT_ID_PATTERN.test(value)) throw attachmentNotFound();
  return value;
};

const actorOf = (
  access: ResolvedProjectAccess,
  user: AuthUser,
  ctx: AuditContext,
): AttachmentActor => ({ userId: user.id, role: access.role, ctx });

/**
 * Board card attachments (issue #309, ADR-0031 §3): operators upload and
 * delete their own (an admin anyone's); every member reads. A project the
 * caller cannot see is 404 on every route. Claiming onto an existing card
 * is a board route (`BoardAttachmentsController`).
 */
@Controller('projects/:projectId/attachments')
@UseGuards(ProjectAccessGuard)
export class AttachmentsController {
  constructor(
    private readonly attachments: AttachmentsService,
    private readonly live: LiveService,
  ) {}

  /** D12: multipart field `file` → a pending upload. */
  @Post()
  @ProjectRole('operator')
  @UseFilters(UploadTooLargeFilter)
  @UseInterceptors(FileInterceptor(ATTACHMENT_UPLOAD_FIELD))
  upload(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @UploadedFile() file: UploadedAttachment | undefined,
  ): Promise<AttachmentView> {
    return this.attachments.upload(
      access.projectId,
      file,
      actorOf(access, user, ctx),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @ProjectRole('operator')
  async remove(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('id') id: string,
  ): Promise<void> {
    const { cardId } = await this.attachments.remove(
      access.projectId,
      attachmentId(id),
      actorOf(access, user, ctx),
    );
    if (cardId !== null) this.publish(access.projectId, cardId);
  }

  /** D8: the bytes, with the session cookie — never a public URL. */
  @Get(':id/content')
  async content(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const content = await this.attachments.content(
      access.projectId,
      attachmentId(id),
      user.id,
      access.role,
    );
    return sendAttachment(res, content);
  }

  /** The card sheet refreshes its attachments, as on any card change. */
  private publish(projectId: string, cardId: string): void {
    const data: BoardChangedData = { cardId };
    try {
      this.live.publish(`project:${projectId}`, BOARD_CHANGED_EVENT, data);
    } catch {
      // A missed live update is caught up by the next read.
    }
  }
}

/**
 * D9: the runner downloads a card's attachment before `card.run` starts or
 * resumes the worker — with its runner token, never a session.
 */
@Controller('runner/attachments')
export class RunnerAttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get(':id')
  @Public()
  async content(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    // The token is checked before the id: 401 comes first (D9).
    const content = await this.attachments.forRunner(authorization, id);
    return sendAttachment(res, content);
  }
}
