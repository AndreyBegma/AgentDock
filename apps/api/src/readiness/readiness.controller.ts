import type { ProjectReadinessView } from '@agentdock/shared';
import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
import { ReadinessService } from './readiness.service';

/**
 * `GET /projects/:projectId/readiness` (#272 D4): per action, what blocks it.
 * Any project member — it holds no content; a non-member gets 404.
 */
@Controller('projects/:projectId')
@UseGuards(ProjectAccessGuard)
export class ReadinessController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get('readiness')
  @ProjectRole('viewer')
  view(
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<ProjectReadinessView> {
    return this.readiness.view(access.projectId);
  }
}
