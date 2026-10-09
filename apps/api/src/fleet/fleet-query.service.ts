import {
  FLEET_CHANNEL_WINDOW_MS,
  FLEET_ERROR,
  FLEET_ROUNDS_MAX,
  FLEET_SLOTS_PAGE_DEFAULT,
  type FleetChannel,
  type FleetView,
  type RoundView,
  type SlotDetail,
  type SlotPage,
  type SlotStatus,
} from '@agentdock/shared';
import { HttpException, Injectable } from '@nestjs/common';
import type { Round, Slot } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { projectNotFound } from '../projects';
import {
  hasScrapedGroup,
  PLUGIN_ROUND_GROUPS,
  PLUGIN_SLOT_GROUPS,
} from './field-sources';
import {
  toBoardError,
  toOrchestratorView,
  toRoundHeader,
  toRoundView,
  toSlotDetail,
  toSlotSummary,
} from './fleet-mapper';
import { roundDate } from './round-projection';

export interface SlotFilters {
  status?: SlotStatus;
  issue?: number;
}

const slotNotFound = (): HttpException =>
  new HttpException(
    {
      statusCode: 404,
      error: FLEET_ERROR.slotNotFound,
      message: 'Slot not found',
    },
    404,
  );

/** Reads the fleet projections (spec 11 "API"); it never writes. */
@Injectable()
export class FleetQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async fleet(projectId: string): Promise<FleetView> {
    const [project, orchestrator, latestRound, slots] = await Promise.all([
      this.prisma.project.findUnique({
        where: { id: projectId },
        select: {
          baseBranch: true,
          baseOverride: true,
          rootPath: true,
          runnerId: true,
        },
      }),
      this.prisma.fleetOrchestrator.findUnique({ where: { projectId } }),
      this.prisma.round.findFirst({
        where: { projectId },
        orderBy: [{ date: 'desc' }, { label: 'desc' }],
      }),
      this.prisma.slot.findMany({
        where: { projectId, status: { not: 'ended' } },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    if (!project) throw projectNotFound();
    return {
      projectId,
      fleetChannel: await this.channel(project, latestRound, slots),
      orchestrator: toOrchestratorView(orchestrator),
      base: latestRound?.base ?? project.baseOverride ?? project.baseBranch,
      latestRound: latestRound ? toRoundHeader(latestRound) : null,
      boardError: toBoardError(orchestrator),
      slots: slots.map(toSlotSummary),
    };
  }

  /**
   * Spec 16 D8: `events` once a Code Sentinel event for the project's root
   * arrived in the last 24 h; `both` while a live slot or the latest round
   * still carries a plugin-covered field last written from markdown.
   */
  private async channel(
    project: { rootPath: string; runnerId: string },
    latestRound: Round | null,
    slots: Slot[],
  ): Promise<FleetChannel> {
    const recent = await this.prisma.event.findFirst({
      where: {
        projectRoot: project.rootPath,
        runnerId: project.runnerId,
        source: 'code-sentinel',
        receivedAt: { gte: new Date(Date.now() - FLEET_CHANNEL_WINDOW_MS) },
      },
      select: { id: true },
    });
    if (!recent) return 'scraped';
    const mixed =
      slots.some((s) => hasScrapedGroup(s.sources, PLUGIN_SLOT_GROUPS)) ||
      (latestRound !== null &&
        hasScrapedGroup(latestRound.sources, PLUGIN_ROUND_GROUPS));
    return mixed ? 'both' : 'events';
  }

  /** Newest first; the cursor is the id of the previous page's last slot. */
  async slots(
    projectId: string,
    filters: SlotFilters,
    cursor?: string,
    limit = FLEET_SLOTS_PAGE_DEFAULT,
  ): Promise<SlotPage> {
    const rows = await this.prisma.slot.findMany({
      where: {
        projectId,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.issue !== undefined ? { issue: filters.issue } : {}),
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map(toSlotSummary),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  /** The latest run of the slot by that name. */
  async slot(projectId: string, name: string): Promise<SlotDetail> {
    const row = await this.prisma.slot.findFirst({
      where: { projectId, name },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      include: { checkpoints: { orderBy: { position: 'asc' } } },
    });
    if (!row) throw slotNotFound();
    return toSlotDetail(row);
  }

  /** Newest first, at most `FLEET_ROUNDS_MAX`. */
  async rounds(projectId: string, date?: string): Promise<RoundView[]> {
    const rows = await this.prisma.round.findMany({
      where: { projectId, ...(date ? { date: roundDate(date) } : {}) },
      orderBy: [{ date: 'desc' }, { label: 'desc' }],
      take: FLEET_ROUNDS_MAX,
    });
    return rows.map(toRoundView);
  }
}
