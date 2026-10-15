import type { PlannerInstructionsView, TaskPage } from '@agentdock/shared';
import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { AuditCtx } from '../audit';
import type { AuditContext } from '../audit/audit.types';
import { type AuthUser, CurrentUser, Roles } from '../auth';
import { PlannerInstructionsDto, TasksQueryDto } from './dto';
import { PlannerInstructionsService } from './planner-instructions.service';
import { TasksQueryService } from './tasks-query.service';

/** The global planner instructions (D11, ADR-0019): a site admin's. */
@Controller('admin/planner')
@Roles('admin')
export class PlannerAdminController {
  constructor(private readonly instructions: PlannerInstructionsService) {}

  @Get('instructions')
  instructionsView(): Promise<PlannerInstructionsView> {
    return this.instructions.global();
  }

  @Put('instructions')
  update(
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: PlannerInstructionsDto,
  ): Promise<PlannerInstructionsView> {
    return this.instructions.updateGlobal(ctx, user.id, dto.body);
  }
}

/**
 * Tasks of every plan the caller may read, across their projects.
 *
 * @deprecated Issue #270 D9: `GET /work` (the Work List) replaces it for the
 * web. Kept unchanged for one release so the API and web merge in either
 * order; a follow-up removes it.
 */
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksQueryService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: TasksQueryDto,
  ): Promise<TaskPage> {
    return this.tasks.list(user, query);
  }
}
