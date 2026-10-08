import type {
  CreateIssueResult,
  QueueIssueDetail,
  QueueRefreshResult,
  QueueView,
} from '@agentdock/shared';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuditCtx } from '../audit';
import type { AuditContext } from '../audit/audit.types';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
import { CreateIssueDto, QueueListQuery } from './dto';
import { QueueService } from './queue.service';
import { QueueQueryService } from './queue-query.service';

/**
 * The task queue (spec 19 "API"). Reading needs membership; filing an issue
 * or asking for a poll needs operator on the project (D10). A project the
 * caller cannot see is 404, an anonymous caller 401.
 */
@Controller('projects/:projectId')
@UseGuards(ProjectAccessGuard)
export class QueueController {
  constructor(
    private readonly query: QueueQueryService,
    private readonly queue: QueueService,
  ) {}

  @Get('queue')
  list(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Query() query: QueueListQuery,
  ): Promise<QueueView> {
    return this.query.queue(access.projectId, {
      state: query.state,
      includeOpen: query.include === 'open',
    });
  }

  @Get('queue/:number')
  issue(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('number', ParseIntPipe) number: number,
  ): Promise<QueueIssueDetail> {
    return this.query.issue(access.projectId, number);
  }

  @Post('queue/refresh')
  @HttpCode(200)
  @ProjectRole('operator')
  refresh(
    @ProjectAccess() access: ResolvedProjectAccess,
    @AuditCtx() ctx: AuditContext,
  ): Promise<QueueRefreshResult> {
    return this.queue.refresh({ ...access, ctx });
  }

  @Post('issues')
  @ProjectRole('operator')
  createIssue(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Body() dto: CreateIssueDto,
    @AuditCtx() ctx: AuditContext,
  ): Promise<CreateIssueResult> {
    return this.queue.createIssue({ ...access, ctx }, dto);
  }
}
