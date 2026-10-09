import {
  RUN_DETAIL_ACTIVITY_MAX,
  RUN_PAGE_DEFAULT,
  type RunDetail,
  type RunPage,
  type RunSummary,
  type RunUsage,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  ActivityQueryService,
  activityError,
  badCursor,
  decodeKeyset,
  encodeKeyset,
} from '../activity';
import { PrismaService } from '../database/prisma.service';
import type { RunListQueryDto } from './dto';
import { EMPTY_USAGE, usageByRun, usageBySession } from './run-usage';

const runInclude = {
  slot: { select: { name: true, prChecks: true } },
} as const satisfies Prisma.RunInclude;

type RunRow = Prisma.RunGetPayload<{ include: typeof runInclude }>;

const toSummary = (row: RunRow, usage: RunUsage): RunSummary => ({
  id: row.id,
  kind: row.kind,
  projectId: row.projectId,
  slotId: row.slotId,
  slot: row.slot?.name ?? null,
  issue: row.issue,
  title: row.title,
  runtime: row.runtime,
  model: row.model,
  profileKey: row.profileKey,
  output: row.output,
  status: row.status,
  outcome: row.outcome,
  prNumber: row.prNumber,
  prUrl: row.prUrl,
  prChecks: row.prNumber !== null ? (row.slot?.prChecks ?? null) : null,
  triggeredByType: row.triggeredByType,
  triggeredById: row.triggeredById,
  startedAt: row.startedAt.toISOString(),
  endedAt: row.endedAt?.toISOString() ?? null,
  durationMs: row.durationMs,
  updatedAt: row.updatedAt.toISOString(),
  usage,
});

const runNotFound = () => activityError(404, 'not_found', 'Run not found');

/** History reads (spec 21 "API", D8, D11); the guard already checked membership. */
@Injectable()
export class RunsQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityQueryService,
  ) {}

  /** Runs of a project, newest first, with tokens and cost (D8). */
  async list(projectId: string, query: RunListQueryDto): Promise<RunPage> {
    const limit = query.limit ?? RUN_PAGE_DEFAULT;
    const and: Prisma.RunWhereInput[] = [{ projectId }];
    if (query.kind) and.push({ kind: query.kind });
    if (query.status) and.push({ status: query.status });
    if (query.issue) and.push({ issue: query.issue });
    if (query.from) and.push({ startedAt: { gte: new Date(query.from) } });
    if (query.to) and.push({ startedAt: { lt: new Date(query.to) } });
    if (query.cursor) {
      const key = decodeKeyset(query.cursor);
      if (!key) throw badCursor();
      and.push({
        OR: [
          { startedAt: { lt: key.at } },
          { startedAt: key.at, id: { lt: key.id } },
        ],
      });
    }
    const rows = await this.prisma.run.findMany({
      where: { AND: and },
      include: runInclude,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const usage = await usageByRun(
      this.prisma,
      page.map((r) => r.id),
    );
    const last = page.at(-1);
    return {
      items: page.map((row) =>
        toSummary(row, usage.get(row.id) ?? EMPTY_USAGE),
      ),
      nextCursor:
        rows.length > limit && last
          ? encodeKeyset({ at: last.startedAt, id: last.id })
          : null,
    };
  }

  /** One run: its slot's checkpoints, sessions with their usage, and activity. */
  async detail(projectId: string, runId: string): Promise<RunDetail> {
    const row = await this.prisma.run.findFirst({
      where: { id: runId, projectId },
      include: runInclude,
    });
    if (!row) throw runNotFound();
    const usage = (await usageByRun(this.prisma, [row.id])).get(row.id);
    const summary = toSummary(row, usage ?? EMPTY_USAGE);
    if (!row.slotId || !row.slot) {
      return { ...summary, checkpoints: [], sessions: [], activity: [] };
    }

    const [checkpoints, sessions, perSession, activity] = await Promise.all([
      this.prisma.slotCheckpoint.findMany({
        where: { slotId: row.slotId },
        orderBy: { position: 'asc' },
      }),
      this.prisma.agentSession.findMany({
        where: {
          projectId,
          slotName: row.slot.name,
          lastEventAt: { gte: row.startedAt },
          ...(row.endedAt ? { startedAt: { lte: row.endedAt } } : {}),
        },
        orderBy: { startedAt: 'asc' },
      }),
      usageBySession(this.prisma, row.id),
      this.activity.forSlot(
        projectId,
        row.slot.name,
        row.startedAt,
        row.endedAt,
        RUN_DETAIL_ACTIVITY_MAX,
      ),
    ]);
    return {
      ...summary,
      checkpoints: checkpoints.map((c) => ({
        kind: c.kind,
        heading: c.heading,
        summary: c.summary,
        position: c.position,
        at: c.at.toISOString(),
      })),
      sessions: sessions.map((s) => ({
        id: s.id,
        runtime: s.runtime,
        externalId: s.externalId,
        title: s.title,
        startedAt: s.startedAt.toISOString(),
        lastEventAt: s.lastEventAt.toISOString(),
        endedAt: s.endedAt?.toISOString() ?? null,
        usage: perSession.get(s.id) ?? EMPTY_USAGE,
      })),
      activity,
    };
  }
}
