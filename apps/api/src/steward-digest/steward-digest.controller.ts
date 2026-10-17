import type { StewardDigestView } from '@agentdock/shared';
import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ProjectAccess,
  ProjectAccessGuard,
  type ResolvedProjectAccess,
} from '../projects';
import { StewardDigestService } from './steward-digest.service';

/**
 * `GET /projects/:projectId/steward/digest/latest` (#447 "API"): any member of
 * the project reads it; a project the caller cannot see is 404, so project A's
 * member never learns whether B has a digest. Before the first digest, 404.
 */
@Controller('projects/:projectId/steward/digest')
@UseGuards(ProjectAccessGuard)
export class StewardDigestController {
  constructor(private readonly digests: StewardDigestService) {}

  @Get('latest')
  latest(
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<StewardDigestView> {
    return this.digests.latest(access.projectId);
  }
}
