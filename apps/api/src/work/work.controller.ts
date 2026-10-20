import type { BoardPlanTasksView, WorkPage } from '@nautelle/shared';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { type AuthUser, CurrentUser } from '../auth';
import {
  ProjectAccess,
  ProjectAccessGuard,
  type ResolvedProjectAccess,
} from '../projects';
import { WorkQueryDto } from './dto';
import { PlanTasksService } from './plan-tasks.service';
import { WorkQueryService } from './work-query.service';

/**
 * The Work List (issue #270 D10, D11): cards, plan tasks and Inbox
 * suggestions across the caller's projects. Any signed-in user; what each
 * project contributes follows the caller's role there.
 */
@Controller('work')
export class WorkController {
  constructor(private readonly work: WorkQueryService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: WorkQueryDto,
  ): Promise<WorkPage> {
    return this.work.list(user, query);
  }
}

/** The plan tasks of one project's Board (D8): viewers read; non-members 404. */
@Controller('projects/:projectId/work')
@UseGuards(ProjectAccessGuard)
export class BoardPlanTasksController {
  constructor(private readonly planTasks: PlanTasksService) {}

  @Get('plan-tasks')
  list(
    @CurrentUser() user: AuthUser,
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<BoardPlanTasksView> {
    return this.planTasks.board(user, access.projectId);
  }
}
