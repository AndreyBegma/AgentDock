import {
  FLEET_ERROR,
  FLEET_ROUNDS_MAX,
  FLEET_SLOTS_PAGE_DEFAULT,
  type FleetView,
  type RoundView,
  type SlotDetail,
  type SlotPage,
  type SlotStatus,
} from '@agentdock/shared';
import { HttpException, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { projectNotFound } from '../projects';
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
        select: { baseBranch: true, baseOverride: true },
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
      orchestrator: toOrchestratorView(orchestrator),
      base: latestRound?.base ?? project.baseOverride ?? project.baseBranch,
      latestRound: latestRound ? toRoundHeader(latestRound) : null,
      boardError: toBoardError(orchestrator),
      slots: slots.map(toSlotSummary),
    };
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
