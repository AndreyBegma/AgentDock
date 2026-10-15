import type { TerminalSetupView } from '@agentdock/shared';
import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
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
}
