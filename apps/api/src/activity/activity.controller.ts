import type { ActivityPage } from '@agentdock/shared';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { AuthUser } from '../auth';
import { CurrentUser } from '../auth/decorators';
import {
  ProjectAccess,
  ProjectAccessGuard,
  type ResolvedProjectAccess,
} from '../projects';
import { ActivityQueryService } from './activity-query.service';
import { ActivityListQuery, ProjectActivityQuery } from './dto';

/** The global feed (spec 21 "API"): any signed-in user, scoped by membership (D10). */
@Controller('activity')
export class ActivityController {
  constructor(private readonly activity: ActivityQueryService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: ActivityListQuery,
  ): Promise<ActivityPage> {
    return this.activity.global(user, query);
  }
}

/** One project's feed: any member (viewer suffices); a non-member gets 404. */
@Controller('projects/:projectId/activity')
@UseGuards(ProjectAccessGuard)
export class ProjectActivityController {
  constructor(private readonly activity: ActivityQueryService) {}

  @Get()
  list(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Query() query: ProjectActivityQuery,
  ): Promise<ActivityPage> {
    return this.activity.project(access.projectId, query);
  }
}
