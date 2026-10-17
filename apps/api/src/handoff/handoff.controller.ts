import type { CardHandoffView } from '@agentdock/shared';
import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { AuditCtx } from '../audit';
import type { AuditContext } from '../audit/audit.types';
import { cardNumber } from '../board/board.controller';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
import { PutCardHandoffDto } from './dto';
import { HandoffService } from './handoff.service';

/**
 * A card's handoff note (#449 D7): members read it (D-03), operators edit
 * it. A project the caller cannot see is 404, a card of another project too.
 */
@Controller('projects/:projectId/board/cards/:number/handoff')
@UseGuards(ProjectAccessGuard)
export class HandoffController {
  constructor(private readonly handoff: HandoffService) {}

  @Get()
  view(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('number') number: string,
  ): Promise<CardHandoffView> {
    return this.handoff.view(access.projectId, cardNumber(number));
  }

  @Put()
  @ProjectRole('operator')
  put(
    @ProjectAccess() access: ResolvedProjectAccess,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
    @Body() dto: PutCardHandoffDto,
  ): Promise<CardHandoffView> {
    return this.handoff.put(access.projectId, cardNumber(number), dto.content, {
      role: access.role,
      ctx,
    });
  }
}
