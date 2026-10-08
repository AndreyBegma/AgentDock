import type { RunDetail, RunPage } from '@agentdock/shared';
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ProjectAccess,
  ProjectAccessGuard,
  type ResolvedProjectAccess,
} from '../projects';
import { RunListQueryDto } from './dto';
import { RunsQueryService } from './runs-query.service';

/**
 * Execution history (spec 21 "API"). Read-only, so any member may call it
 * (D10); a project the caller cannot see is 404.
 */
@Controller('projects/:projectId/runs')
@UseGuards(ProjectAccessGuard)
export class RunsController {
  constructor(private readonly runs: RunsQueryService) {}

  @Get()
  list(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Query() query: RunListQueryDto,
  ): Promise<RunPage> {
    return this.runs.list(access.projectId, query);
  }

  @Get(':runId')
  detail(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('runId') runId: string,
  ): Promise<RunDetail> {
    return this.runs.detail(access.projectId, runId);
  }
}
