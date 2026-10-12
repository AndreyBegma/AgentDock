import type {
  AdminScheduleView,
  ScheduleDetail,
  ScheduleFiringView,
  SchedulePreviewView,
  ScheduleView,
  SystemJobView,
} from '@agentdock/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuditCtx } from '../audit';
import type { AuditContext } from '../audit/audit.types';
import { type AuthUser, CurrentUser, Roles } from '../auth';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
import {
  AdminSchedulesQueryDto,
  ScheduleCreateDto,
  SchedulePreviewDto,
  ScheduleUpdateDto,
} from './dto';
import { SchedulesService } from './schedules.service';
import { SystemJobs } from './system-jobs';

/**
 * A project's schedules (spec 25 "API", D14): a member reads them, an
 * operator changes and runs them. A project the caller cannot see is 404 on
 * every route (#10 D12).
 */
@Controller('projects/:projectId/schedules')
@UseGuards(ProjectAccessGuard)
export class ProjectSchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get()
  list(
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<ScheduleView[]> {
    return this.schedules.list(access.projectId);
  }

  @Post()
  @ProjectRole('operator')
  create(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: ScheduleCreateDto,
  ): Promise<ScheduleView> {
    return this.schedules.create(access.projectId, dto, {
      userId: user.id,
      ctx,
    });
  }

  @Get(':id')
  detail(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('id') id: string,
  ): Promise<ScheduleDetail> {
    return this.schedules.detail(access.projectId, id);
  }

  @Patch(':id')
  @ProjectRole('operator')
  update(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('id') id: string,
    @Body() dto: ScheduleUpdateDto,
  ): Promise<ScheduleView> {
    return this.schedules.update(access.projectId, id, dto, {
      userId: user.id,
      ctx,
    });
  }

  @Delete(':id')
  @HttpCode(204)
  @ProjectRole('operator')
  remove(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('id') id: string,
  ): Promise<void> {
    return this.schedules.remove(access.projectId, id, {
      userId: user.id,
      ctx,
    });
  }

  @Post(':id/run-now')
  @ProjectRole('operator')
  runNow(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('id') id: string,
  ): Promise<ScheduleFiringView> {
    return this.schedules.runNow(access.projectId, id, {
      userId: user.id,
      ctx,
    });
  }
}

/** `POST /schedules/preview`: any signed-in user. */
@Controller('schedules')
export class SchedulePreviewController {
  constructor(private readonly schedules: SchedulesService) {}

  @Post('preview')
  @HttpCode(200)
  preview(@Body() dto: SchedulePreviewDto): SchedulePreviewView {
    return this.schedules.preview(dto.cron, dto.timezone);
  }
}

/** Every project's schedules and the API's own jobs (D13, D14): admin only. */
@Roles('admin')
@Controller('admin')
export class AdminSchedulesController {
  constructor(
    private readonly schedules: SchedulesService,
    private readonly jobs: SystemJobs,
  ) {}

  @Get('schedules')
  list(@Query() query: AdminSchedulesQueryDto): Promise<AdminScheduleView[]> {
    return this.schedules.adminList(query);
  }

  @Get('system-jobs')
  systemJobs(): SystemJobView[] {
    return this.jobs.list();
  }
}
