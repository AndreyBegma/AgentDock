import type { TerminalSetupView } from '@nautelle/shared';
import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import type { AuditContext } from '../audit/audit.types';
import { AuditCtx } from '../audit/audit-context';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
import { IgnoreTerminalSetupProfileDto } from './dto';
import { TerminalSetupService } from './terminal-setup.service';

/**
 * `GET /projects/:projectId/terminal-setup` (#281 D5). Any project member —
 * profile keys are already visible to them; a non-member gets 404.
 */
@Controller('projects/:projectId')
@UseGuards(ProjectAccessGuard)
export class TerminalSetupController {
  constructor(private readonly setup: TerminalSetupService) {}

  @Get('terminal-setup')
  @ProjectRole('viewer')
  view(
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<TerminalSetupView> {
    return this.setup.view(access.projectId);
  }

  /**
   * #719: hide a profile from Nautelle on the project's runner, or show it
   * again. A project admin's: it changes the checklist of every project on
   * that runner.
   */
  @Put('terminal-setup/ignored-profiles')
  @ProjectRole('admin')
  setIgnored(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Body() dto: IgnoreTerminalSetupProfileDto,
    @AuditCtx() ctx: AuditContext,
  ): Promise<TerminalSetupView> {
    return this.setup.setIgnored(
      access.projectId,
      dto.profileKey,
      dto.ignored,
      ctx,
    );
  }
}
