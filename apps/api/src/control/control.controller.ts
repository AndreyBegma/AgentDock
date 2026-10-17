import type {
  CommandRunPage,
  CommandRunView,
  OrchestratorSettingsView,
  OrchestratorStatusView,
  SessionMessageView,
} from '@agentdock/shared';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuditCtx } from '../audit';
import type { AuditContext } from '../audit/audit.types';
import { type AuthUser, CurrentUser, RunnerReadThrottle } from '../auth';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
import { SessionMessageDto, sessionMessageInput } from '../session-message/dto';
import { CommandRunsService } from './command-runs.service';
import { type ControlCaller, ControlService } from './control.service';
import {
  CommandRunListQueryDto,
  OrchestratorMessageDto,
  OrchestratorSettingsDto,
  OrchestratorStartDto,
  SlotMessageDto,
} from './dto';
import { OrchestratorSettingsService } from './orchestrator-settings.service';
import { SlotSessionMessages } from './slot-session-message.service';

const callerOf = (
  access: ResolvedProjectAccess,
  user: AuthUser,
  ctx: AuditContext,
): ControlCaller => ({
  ...access,
  user: { id: user.id, email: user.email },
  ctx,
});

/**
 * Orchestrator and slot control (spec 17 "API"). Reading needs membership;
 * every command needs operator on the project (D9), and `bypassPermissions`
 * admin (D3). A project the caller cannot see is 404, an anonymous caller 401.
 */
@Controller('projects/:projectId')
@UseGuards(ProjectAccessGuard)
export class ControlController {
  constructor(
    private readonly control: ControlService,
    private readonly settings: OrchestratorSettingsService,
    private readonly runs: CommandRunsService,
    private readonly sessionMessages: SlotSessionMessages,
  ) {}

  @Post('orchestrator/start')
  @ProjectRole('operator')
  start(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: OrchestratorStartDto,
  ): Promise<CommandRunView> {
    return this.control.start(callerOf(access, user, ctx), dto);
  }

  @Post('orchestrator/stop')
  @ProjectRole('operator')
  stop(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
  ): Promise<CommandRunView> {
    return this.control.stop(callerOf(access, user, ctx));
  }

  @Post('orchestrator/message')
  @ProjectRole('operator')
  messageOrchestrator(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: OrchestratorMessageDto,
  ): Promise<CommandRunView> {
    return this.control.messageOrchestrator(
      callerOf(access, user, ctx),
      dto.body,
    );
  }

  /** Read live from the runner, cached briefly per project (C-119). */
  @Get('orchestrator/status')
  @RunnerReadThrottle()
  status(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
  ): Promise<OrchestratorStatusView> {
    return this.control.status(callerOf(access, user, ctx));
  }

  @Get('orchestrator/settings')
  getSettings(
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<OrchestratorSettingsView> {
    return this.settings.get(access.projectId);
  }

  @Put('orchestrator/settings')
  @ProjectRole('operator')
  putSettings(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: OrchestratorSettingsDto,
  ): Promise<OrchestratorSettingsView> {
    return this.settings.update({ ...access, userId: user.id, ctx }, dto);
  }

  @Post('slots/:slot/stop')
  @ProjectRole('operator')
  stopSlot(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('slot') slot: string,
  ): Promise<CommandRunView> {
    return this.control.stopSlot(
      callerOf(access, user, ctx),
      this.control.parseSlot(slot),
    );
  }

  @Post('slots/:slot/message')
  @ProjectRole('operator')
  messageSlot(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('slot') slot: string,
    @Body() dto: SlotMessageDto,
  ): Promise<CommandRunView> {
    return this.control.messageSlot(
      callerOf(access, user, ctx),
      this.control.parseSlot(slot),
      dto.text,
    );
  }

  /** #489 M5: text or an answer typed into the worker's own session. */
  @Post('slots/:slot/session-message')
  @HttpCode(200)
  @ProjectRole('operator')
  sessionMessageSlot(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('slot') slot: string,
    @Body() dto: SessionMessageDto,
  ): Promise<SessionMessageView> {
    return this.sessionMessages.message(
      callerOf(access, user, ctx),
      this.control.parseSlot(slot),
      sessionMessageInput(dto),
    );
  }

  @Get('command-runs')
  commandRuns(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Query() query: CommandRunListQueryDto,
  ): Promise<CommandRunPage> {
    return this.runs.list(access.projectId, query);
  }
}
