import type {
  FleetGraph,
  FleetView,
  RoundView,
  SlotConversation,
  SlotDetail,
  SlotPage,
  SlotWorktreeView,
} from '@nautelle/shared';
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuditCtx } from '../audit';
import type { AuditContext } from '../audit/audit.types';
import { RunnerReadThrottle } from '../auth';
import {
  ProjectAccess,
  ProjectAccessGuard,
  type ResolvedProjectAccess,
} from '../projects';
import { RoundListQuery, SlotListQuery } from './dto';
import { FleetQueryService } from './fleet-query.service';
import { FleetWorkspaceService } from './fleet-workspace.service';

/**
 * Fleet observation (spec 11 "API"). Read-only, so any member may call it
 * (D10); a project the caller cannot see is 404, an anonymous caller 401.
 */
@Controller('projects/:projectId')
@UseGuards(ProjectAccessGuard)
export class FleetController {
  constructor(
    private readonly fleet: FleetQueryService,
    private readonly workspace: FleetWorkspaceService,
  ) {}

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

  /** The agent workspace's tree (spec 160). */
  @Get('fleet/graph')
  graph(@ProjectAccess() access: ResolvedProjectAccess): Promise<FleetGraph> {
    return this.workspace.graph(access.projectId);
  }

  /** The latest run's orchestrator ↔ worker conversation (spec 160). */
  @Get('slots/:slot/conversation')
  conversation(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('slot') slot: string,
  ): Promise<SlotConversation> {
    return this.workspace.conversation(
      access.projectId,
      this.workspace.parseSlot(slot),
    );
  }

  /** The slot's worktree, read by the runner (`worktree.status`), cached 10 s. */
  @Get('slots/:slot/worktree')
  @RunnerReadThrottle()
  worktree(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('slot') slot: string,
    @AuditCtx() ctx: AuditContext,
  ): Promise<SlotWorktreeView> {
    return this.workspace.worktree(
      { projectId: access.projectId, role: access.role, ctx },
      this.workspace.parseSlot(slot),
    );
  }

  @Get('rounds')
  rounds(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Query() query: RoundListQuery,
  ): Promise<RoundView[]> {
    return this.fleet.rounds(access.projectId, query.date);
  }
}
