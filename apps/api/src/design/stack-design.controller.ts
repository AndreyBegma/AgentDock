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
import { stackNumber } from '../board/board.controller';
import type { PlanActor } from '../planner/plan.service';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
import { DesignService } from './design.service';
import { DesignStopService } from './design-stop.service';
import { DesignApproveDto, DesignCommentDto, TaskDesignPatchDto } from './dto';

const actorOf = (
  access: ResolvedProjectAccess,
  user: AuthUser,
  ctx: AuditContext,
): PlanActor => ({ userId: user.id, role: access.role, ctx });

/**
 * A stack's shared design (#480, ADR-0044): the routes of a card's design
 * (#243) at the stack's number. Any project viewer reads it; the switch,
 * Generate, comments, Revise, Stop and Approve need an operator. Its turns
 * run with the project's profile and model — there is no launch choice.
 * Writes answer the design as it now is.
 */
@Controller('projects/:projectId/board/stacks/:number/design')
@UseGuards(ProjectAccessGuard)
export class StackDesignController {
  constructor(
    private readonly designs: DesignService,
    private readonly stops: DesignStopService,
  ) {}

  @Get()
  view(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('number') number: string,
  ): Promise<TaskDesignView> {
    return this.designs.stackView(access.projectId, stackNumber(number));
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
    const n = stackNumber(number);
    await this.designs.stackPatch(
      access.projectId,
      n,
      dto,
      actorOf(access, user, ctx),
    );
    return this.designs.stackView(access.projectId, n);
  }

  @Post('generate')
  @ProjectRole('operator')
  async generate(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
  ): Promise<TaskDesignView> {
    const n = stackNumber(number);
    await this.designs.stackGenerate(
      access.projectId,
      n,
      actorOf(access, user, ctx),
    );
    return this.designs.stackView(access.projectId, n);
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
    const n = stackNumber(number);
    await this.designs.stackComment(
      access.projectId,
      n,
      dto,
      actorOf(access, user, ctx),
    );
    return this.designs.stackView(access.projectId, n);
  }

  @Post('revise')
  @ProjectRole('operator')
  async revise(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
  ): Promise<TaskDesignView> {
    const n = stackNumber(number);
    await this.designs.stackRevise(
      access.projectId,
      n,
      actorOf(access, user, ctx),
    );
    return this.designs.stackView(access.projectId, n);
  }

  @Post('stop')
  @HttpCode(200)
  @ProjectRole('operator')
  async stop(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('number') number: string,
  ): Promise<TaskDesignView> {
    const n = stackNumber(number);
    await this.stops.stackStop(access.projectId, n, actorOf(access, user, ctx));
    return this.designs.stackView(access.projectId, n);
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
    const n = stackNumber(number);
    await this.designs.stackApprove(
      access.projectId,
      n,
      dto.revisionId,
      actorOf(access, user, ctx),
    );
    return this.designs.stackView(access.projectId, n);
  }
}
