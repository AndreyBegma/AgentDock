import type {
  DesignSettingsView,
  TaskDesignView,
  UiProfileRebuildResult,
  UiProfileVersionsView,
  UiProfileVersionView,
  UiProfileView,
} from '@agentdock/shared';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuditCtx } from '../audit';
import type { AuditContext } from '../audit/audit.types';
import { type AuthUser, CurrentUser } from '../auth';
import { callerOf, type PlanActor } from '../planner/plan.service';
import { PlanStore } from '../planner/plan-store';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
import { DesignService } from './design.service';
import { DesignSettingsService } from './design-settings.service';
import { DesignStopService } from './design-stop.service';
import {
  DesignApproveDto,
  DesignCommentDto,
  DesignSettingsDto,
  TaskDesignPatchDto,
  UiProfileUpdateDto,
  UiProfileVersionsQueryDto,
} from './dto';
import { sendMockup } from './mockup-response';
import { UiProfileService } from './ui-profile.service';

const actorOf = (
  access: ResolvedProjectAccess,
  user: AuthUser,
  ctx: AuditContext,
): PlanActor => ({ userId: user.id, role: access.role, ctx });

/**
 * The design stage's project routes (docs/specs/223-design-stage.md "API",
 * D17). `ProjectAccessGuard` hides a project the caller cannot see (404) and
 * refuses a write below its role (403): reading needs a member, a design
 * write or a rebuild an operator, a profile edit or the settings a project
 * admin. A design is read and written through its plan's rule, so a plan the
 * caller may not read is 404 as well. Design writes answer the design as the
 * caller now sees it.
 */
@Controller('projects/:projectId')
@UseGuards(ProjectAccessGuard)
export class DesignController {
  constructor(
    private readonly designs: DesignService,
    private readonly stops: DesignStopService,
    private readonly profiles: UiProfileService,
    private readonly settings: DesignSettingsService,
    private readonly store: PlanStore,
  ) {}

  @Get('ui-profile')
  profile(
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<UiProfileView> {
    return this.profiles.view(access.projectId);
  }

  @Get('ui-profile/versions')
  versions(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Query() query: UiProfileVersionsQueryDto,
  ): Promise<UiProfileVersionsView | UiProfileVersionView> {
    return query.version !== undefined
      ? this.profiles.version(access.projectId, query.version)
      : this.profiles.versions(access.projectId);
  }

  /** Settings → Design: the version's snippets, served like a mockup. */
  @Get('ui-profile/preview')
  async preview(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Query() query: UiProfileVersionsQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    sendMockup(
      res,
      await this.profiles.previewHtml(access.projectId, query.version),
    );
  }

  @Put('ui-profile')
  @ProjectRole('admin')
  updateProfile(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: UiProfileUpdateDto,
  ): Promise<UiProfileVersionView> {
    return this.profiles.update(
      access.projectId,
      callerOf(actorOf(access, user, ctx)),
      dto,
    );
  }

  @Post('ui-profile/rebuild')
  @ProjectRole('operator')
  rebuild(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
  ): Promise<UiProfileRebuildResult> {
    return this.profiles.rebuild(
      access.projectId,
      callerOf(actorOf(access, user, ctx)),
    );
  }

  @Get('design-settings')
  designSettings(
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<DesignSettingsView> {
    return this.settings.view(access.projectId);
  }

  @Put('design-settings')
  @ProjectRole('admin')
  updateDesignSettings(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: DesignSettingsDto,
  ): Promise<DesignSettingsView> {
    return this.settings.update(ctx, user.id, access.projectId, dto);
  }

  @Get('plans/:planId/tasks/:key/design')
  design(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @Param('planId') planId: string,
    @Param('key') key: string,
  ): Promise<TaskDesignView> {
    return this.designs.view(access.projectId, user.id, planId, key);
  }

  @Patch('plans/:planId/tasks/:key/design')
  @ProjectRole('operator')
  async patch(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('planId') planId: string,
    @Param('key') key: string,
    @Body() dto: TaskDesignPatchDto,
  ): Promise<TaskDesignView> {
    const plan = await this.store.readable(user.id, access.projectId, planId);
    await this.designs.patch(plan, key, dto, actorOf(access, user, ctx));
    return this.designs.view(access.projectId, user.id, planId, key);
  }

  @Post('plans/:planId/tasks/:key/design/generate')
  @ProjectRole('operator')
  async generate(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('planId') planId: string,
    @Param('key') key: string,
  ): Promise<TaskDesignView> {
    const plan = await this.store.readable(user.id, access.projectId, planId);
    await this.designs.generate(plan, key, actorOf(access, user, ctx));
    return this.designs.view(access.projectId, user.id, planId, key);
  }

  /** #275 D5: no body; nothing running is 409 `design_not_running`. */
  @Post('plans/:planId/tasks/:key/design/stop')
  @HttpCode(200)
  @ProjectRole('operator')
  async stop(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('planId') planId: string,
    @Param('key') key: string,
  ): Promise<TaskDesignView> {
    const plan = await this.store.readable(user.id, access.projectId, planId);
    await this.stops.stop(plan, key, actorOf(access, user, ctx));
    return this.designs.view(access.projectId, user.id, planId, key);
  }

  @Post('plans/:planId/tasks/:key/design/comments')
  @ProjectRole('operator')
  async comment(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('planId') planId: string,
    @Param('key') key: string,
    @Body() dto: DesignCommentDto,
  ): Promise<TaskDesignView> {
    const plan = await this.store.readable(user.id, access.projectId, planId);
    await this.designs.comment(plan, key, dto, actorOf(access, user, ctx));
    return this.designs.view(access.projectId, user.id, planId, key);
  }

  @Post('plans/:planId/tasks/:key/design/revise')
  @ProjectRole('operator')
  async revise(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('planId') planId: string,
    @Param('key') key: string,
  ): Promise<TaskDesignView> {
    const plan = await this.store.readable(user.id, access.projectId, planId);
    await this.designs.revise(plan, key, actorOf(access, user, ctx));
    return this.designs.view(access.projectId, user.id, planId, key);
  }

  @Post('plans/:planId/tasks/:key/design/approve')
  @HttpCode(200)
  @ProjectRole('operator')
  async approve(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('planId') planId: string,
    @Param('key') key: string,
    @Body() dto: DesignApproveDto,
  ): Promise<TaskDesignView> {
    const plan = await this.store.readable(user.id, access.projectId, planId);
    await this.designs.approve(
      plan,
      key,
      dto.revisionId,
      actorOf(access, user, ctx),
    );
    return this.designs.view(access.projectId, user.id, planId, key);
  }
}
