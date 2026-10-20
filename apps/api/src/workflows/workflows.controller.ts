import type {
  WorkflowsOrchestrationResponse,
  WorkflowsSummaryResponse,
  WorkflowsToolsResponse,
} from '@nautelle/shared';
import { Controller, Get, Query } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-request';
import { CurrentUser } from '../auth/decorators';
import { WorkflowsQueryDto, WorkflowsToolsQueryDto } from './dto';
import { WorkflowsQueryService } from './workflows-query.service';

/** Workflows analytics (#161). Signed in; scope follows the usage rule. */
@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsQueryService) {}

  @Get('summary')
  summary(
    @CurrentUser() user: AuthUser,
    @Query() query: WorkflowsQueryDto,
  ): Promise<WorkflowsSummaryResponse> {
    return this.workflows.summary(user, query);
  }

  @Get('orchestration')
  orchestration(
    @CurrentUser() user: AuthUser,
    @Query() query: WorkflowsQueryDto,
  ): Promise<WorkflowsOrchestrationResponse> {
    return this.workflows.orchestration(user, query);
  }

  @Get('tools')
  tools(
    @CurrentUser() user: AuthUser,
    @Query() query: WorkflowsToolsQueryDto,
  ): Promise<WorkflowsToolsResponse> {
    return this.workflows.tools(user, query);
  }
}
