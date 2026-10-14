import type { TaskDesignView } from '@agentdock/shared';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuditCtx } from '../audit';
import type { AuditContext } from '../audit/audit.types';
import { type AuthUser, CurrentUser } from '../auth';
import { cardNumber } from '../board/board.controller';
import type { PlanActor } from '../planner/plan.service';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
import { DesignService } from './design.service';
import { DesignApproveDto, DesignCommentDto, TaskDesignPatchDto } from './dto';

const actorOf = (
  access: ResolvedProjectAccess,
  user: AuthUser,
  ctx: AuditContext,
): PlanActor => ({ userId: user.id, role: access.role, ctx });

/**
 * A board card's design (#243 "API", D8; ADR-0025): any project viewer
 * reads it; the switch, Generate, comments, Revise and Approve need an
 * operator. A project the caller cannot see is 404 on every route. Writes
 * answer the design as it now is.
 */
@Controller('projects/:projectId/board/cards/:number/design')
@UseGuards(ProjectAccessGuard)
export class CardDesignController {
  constructor(private readonly designs: DesignService) {}

  @Get()
  view(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('number') number: string,
  ): Promise<TaskDesignView> {
    return this.designs.cardView(access.projectId, cardNumber(number));
  }

  @Patch()
  @ProjectRole('operator')
  async patch(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
    @Body() dto: TaskDesignPatchDto,
  ): Promise<TaskDesignView> {
    const n = cardNumber(number);
    await this.designs.cardPatch(
      access.projectId,
      n,
      dto,
      actorOf(access, user, ctx),
    );
    return this.designs.cardView(access.projectId, n);
  }

  @Post('generate')
  @ProjectRole('operator')
  async generate(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
  ): Promise<TaskDesignView> {
    const n = cardNumber(number);
    await this.designs.cardGenerate(
      access.projectId,
      n,
      actorOf(access, user, ctx),
    );
    return this.designs.cardView(access.projectId, n);
  }

  @Post('comments')
  @ProjectRole('operator')
  async comment(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
    @Body() dto: DesignCommentDto,
  ): Promise<TaskDesignView> {
    const n = cardNumber(number);
    await this.designs.cardComment(
      access.projectId,
      n,
      dto,
      actorOf(access, user, ctx),
    );
    return this.designs.cardView(access.projectId, n);
  }

  @Post('revise')
  @ProjectRole('operator')
  async revise(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
  ): Promise<TaskDesignView> {
    const n = cardNumber(number);
    await this.designs.cardRevise(
      access.projectId,
      n,
      actorOf(access, user, ctx),
    );
    return this.designs.cardView(access.projectId, n);
  }

  @Post('approve')
  @HttpCode(200)
  @ProjectRole('operator')
  async approve(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
    @Body() dto: DesignApproveDto,
  ): Promise<TaskDesignView> {
    const n = cardNumber(number);
    await this.designs.cardApprove(
      access.projectId,
      n,
      dto.revisionId,
      actorOf(access, user, ctx),
    );
    return this.designs.cardView(access.projectId, n);
  }
}
