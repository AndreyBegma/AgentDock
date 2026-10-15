import type { BoardCardDetail } from '@agentdock/shared';
import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuditCtx } from '../audit';
import type { AuditContext } from '../audit/audit.types';
import { type AuthUser, CurrentUser } from '../auth';
import { cardNumber } from '../board/board.controller';
import { BoardService } from '../board/board.service';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
import { ClaimAttachmentsDto } from './dto';

/**
 * #309 D3: `POST /board/cards/:number/attachments` claims pending uploads
 * onto an existing card — the card sheet's dropzone. Served by the board
 * module, which owns the card; creating a card and feedback claim through
 * their own bodies.
 */
@Controller('projects/:projectId/board/cards/:number/attachments')
@UseGuards(ProjectAccessGuard)
export class BoardAttachmentsController {
  constructor(private readonly board: BoardService) {}

  @Post()
  @HttpCode(200)
  @ProjectRole('operator')
  claim(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
    @Body() dto: ClaimAttachmentsDto,
  ): Promise<BoardCardDetail> {
    return this.board.claimAttachments(
      access.projectId,
      cardNumber(number),
      dto.attachmentIds,
      { userId: user.id, role: access.role, ctx },
    );
  }
}
