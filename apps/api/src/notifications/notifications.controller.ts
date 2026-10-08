import type {
  NotificationMuteState,
  NotificationMuteView,
  NotificationPage,
  NotificationReadResult,
  NotificationRulesView,
} from '@agentdock/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { AuditCtx } from '../audit';
import type { AuditContext } from '../audit/audit.types';
import { type AuthUser, CurrentUser } from '../auth';
import {
  NotificationListQueryDto,
  NotificationMuteDto,
  NotificationRulesDto,
} from './dto';
import { notificationError } from './notification-error';
import { NotificationRulesService } from './notification-rules.service';
import { NotificationsService } from './notifications.service';

/**
 * The caller's own notifications, rules and mutes (spec 22 "API", D11). Every
 * route acts on the signed-in user only: there is no user id in any path.
 */
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly rules: NotificationRulesService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: NotificationListQueryDto,
  ): Promise<NotificationPage> {
    return this.notifications.list(user.id, query);
  }

  @Post('read-all')
  @HttpCode(200)
  readAll(@CurrentUser() user: AuthUser): Promise<NotificationReadResult> {
    return this.notifications.markAllRead(user.id);
  }

  @Get('rules')
  getRules(@CurrentUser() user: AuthUser): Promise<NotificationRulesView> {
    return this.rules.rules(user);
  }

  @Put('rules')
  setRules(
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: NotificationRulesDto,
  ): Promise<NotificationRulesView> {
    return this.rules.setRules(user, dto, ctx);
  }

  @Get('mutes')
  mutes(@CurrentUser() user: AuthUser): Promise<NotificationMuteView[]> {
    return this.rules.mutes(user);
  }

  @Get('mutes/:projectId')
  async mute(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
  ): Promise<NotificationMuteState> {
    return { projectId, mute: await this.rules.mute(user, projectId) };
  }

  @Put('mutes/:projectId')
  setMute(
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('projectId') projectId: string,
    @Body() dto: NotificationMuteDto,
  ): Promise<NotificationMuteView> {
    const until = dto.until ? new Date(dto.until) : null;
    if (until && until.getTime() <= Date.now()) {
      throw notificationError(
        400,
        'invalid_rule',
        'until must be in the future',
      );
    }
    return this.rules.setMute(user, projectId, until, ctx);
  }

  @Delete('mutes/:projectId')
  @HttpCode(204)
  unmute(
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('projectId') projectId: string,
  ): Promise<void> {
    return this.rules.unmute(user, projectId, ctx);
  }

  @Post(':id/read')
  @HttpCode(200)
  read(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<NotificationReadResult> {
    return this.notifications.markRead(user.id, id);
  }
}
