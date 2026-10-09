import type {
  FleetView,
  RoundView,
  SlotDetail,
  SlotPage,
} from '@agentdock/shared';
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ProjectAccess,
  ProjectAccessGuard,
  type ResolvedProjectAccess,
} from '../projects';
import { RoundListQuery, SlotListQuery } from './dto';
import { FleetQueryService } from './fleet-query.service';

/**
 * Fleet observation (spec 11 "API"). Read-only, so any member may call it
 * (D10); a project the caller cannot see is 404, an anonymous caller 401.
 */
@Controller('projects/:projectId')
@UseGuards(ProjectAccessGuard)
export class FleetController {
  constructor(private readonly fleet: FleetQueryService) {}

  @Get('fleet')
  overview(@ProjectAccess() access: ResolvedProjectAccess): Promise<FleetView> {
    return this.fleet.fleet(access.projectId);
  }

  @Get('slots')
  slots(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Query() query: SlotListQuery,
  ): Promise<SlotPage> {
    return this.fleet.slots(
      access.projectId,
      { status: query.status, issue: query.issue },
      query.cursor,
      query.limit,
    );
  }

  @Get('slots/:slot')
  slot(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('slot') slot: string,
  ): Promise<SlotDetail> {
    return this.fleet.slot(access.projectId, slot);
  }

  @Get('rounds')
  rounds(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Query() query: RoundListQuery,
  ): Promise<RoundView[]> {
    return this.fleet.rounds(access.projectId, query.date);
  }
}
