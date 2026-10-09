import {
  SESSION_LIST_DEFAULT_LIMIT,
  type SessionDetail,
  type SessionListResponse,
  type SessionTotals,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '../auth';
import { PrismaService } from '../database/prisma.service';
import { ProjectAccessService } from '../projects';
import type { ListSessionsQuery } from './dto';
import { sessionError, sessionNotFound } from './session-error';
import { buildSessionTree, type SessionRow, summaryOf } from './session-tree';

type Caller = Pick<AuthUser, 'id' | 'role'>;

const sessionSelect = {
  id: true,
  runnerId: true,
  runtime: true,
  profileKey: true,
  externalId: true,
  projectId: true,
  slotName: true,
  cwd: true,
  gitBranch: true,
  title: true,
  models: true,
  parentSessionId: true,
  parsed: true,
  startedAt: true,
  lastEventAt: true,
  endedAt: true,
  project: { select: { displayName: true } },
} as const satisfies Prisma.AgentSessionSelect;

type SelectedSession = Prisma.AgentSessionGetPayload<{
  select: typeof sessionSelect;
}>;

const toRow = ({ project, ...row }: SelectedSession): SessionRow => ({
  ...row,
  projectName: project?.displayName ?? null,
});

interface SubtreeTotalsRow {
  root: string;
  subagents: number;
  requests: number;
  input: bigint;
  output: bigint;
  cacheRead: bigint;
  cacheWrite5m: bigint;
  cacheWrite1h: bigint;
  reasoning: bigint;
  costUsd: string | null;
}

const ZERO_TOTALS: SessionTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  reasoning: 0,
  requests: 0,
  costUsd: null,
};

/** Reads sessions under the D10 rule: members see their projects', admins also unassigned ones. */
@Injectable()
export class SessionsQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
  ) {}

  async list(
    user: Caller,
    query: ListSessionsQuery,
  ): Promise<SessionListResponse> {
    if (query.unassigned && query.projectId) {
      throw sessionError(
        400,
        'invalid_filter',
        'unassigned and projectId exclude each other',
      );
    }
    if (query.unassigned && user.role !== 'admin') {
      throw sessionError(
        403,
        'forbidden',
        'Unassigned sessions are visible to admins only',
      );
    }
    if (
      query.projectId &&
      !(await this.access.resolve(user, query.projectId))
    ) {
      throw sessionNotFound();
    }

    const where: Prisma.AgentSessionWhereInput = {
      parentSessionId: null,
      ...(query.unassigned
        ? { projectId: null }
        : query.projectId
          ? { projectId: query.projectId }
          : {
              projectId: { not: null },
              ...(user.role === 'admin'
                ? {}
                : { project: { is: this.access.visibleWhere(user) } }),
            }),
      ...(query.runtime ? { runtime: query.runtime } : {}),
      ...(query.slot ? { slotName: query.slot } : {}),
      ...(query.model ? { models: { array_contains: [query.model] } } : {}),
      ...(query.from || query.to
        ? {
            startedAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lt: new Date(query.to) } : {}),
            },
          }
        : {}),
    };
    const limit = query.limit ?? SESSION_LIST_DEFAULT_LIMIT;
    const rows = await this.prisma.agentSession.findMany({
      where,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: {
        ...sessionSelect,
        _count: { select: { turns: true, toolCalls: true } },
      },
    });
    const page = rows.slice(0, limit);
    const totals = await this.subtreeTotals(page.map((r) => r.id));

    return {
      items: page.map(({ _count, ...row }) => {
        const sum = totals.get(row.id);
        return summaryOf(
          toRow(row),
          {
            turns: _count.turns,
            toolCalls: _count.toolCalls,
            subagents: sum?.subagents ?? 0,
          },
          sum?.totals ?? ZERO_TOTALS,
        );
      }),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async detail(user: Caller, id: string): Promise<SessionDetail> {
    const session = await this.prisma.agentSession.findUnique({
      where: { id },
      select: { id: true, projectId: true },
    });
    if (!session || !(await this.visible(user, session.projectId))) {
      throw sessionNotFound();
    }
    const ids = await this.subtreeIds(id);
    const where = { sessionId: { in: ids } };
    const [sessions, turns, requests, tools] = await Promise.all([
      this.prisma.agentSession.findMany({
        where: { id: { in: ids } },
        select: sessionSelect,
      }),
      this.prisma.turn.findMany({ where }),
      this.prisma.llmRequest.findMany({ where }),
      this.prisma.toolCall.findMany({ where }),
    ]);
    const tree = buildSessionTree(id, {
      sessions: sessions.map(toRow),
      turns,
      requests,
      tools,
    });
    if (!tree) throw sessionNotFound();
    return tree;
  }

  /** D10: a project's sessions to its members; unassigned ones to admins. */
  private async visible(
    user: Caller,
    projectId: string | null,
  ): Promise<boolean> {
    if (user.role === 'admin') return true;
    if (projectId === null) return false;
    return (await this.access.resolve(user, projectId)) !== null;
  }

  /** `id` and every session below it. `UNION` ends a cycle of parent links. */
  private async subtreeIds(id: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH RECURSIVE tree(id) AS (
        SELECT ${id}::text
        UNION
        SELECT s.id FROM sessions s JOIN tree t ON s."parentSessionId" = t.id
      )
      SELECT id FROM tree`;
    return rows.map((r) => r.id);
  }

  /** Totals of each root and every session below it, with its subagent count. */
  private async subtreeTotals(
    roots: string[],
  ): Promise<Map<string, { subagents: number; totals: SessionTotals }>> {
    if (roots.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<SubtreeTotalsRow[]>`
      WITH RECURSIVE tree(root, id) AS (
        SELECT id, id FROM sessions WHERE id IN (${Prisma.join(roots)})
        UNION
        SELECT t.root, s.id FROM sessions s JOIN tree t ON s."parentSessionId" = t.id
      )
      SELECT t.root,
        (COUNT(DISTINCT t.id) - 1)::int AS subagents,
        COUNT(r.id)::int AS requests,
        COALESCE(SUM(r.input), 0)::bigint AS input,
        COALESCE(SUM(r.output), 0)::bigint AS output,
        COALESCE(SUM(r."cacheRead"), 0)::bigint AS "cacheRead",
        COALESCE(SUM(r."cacheWrite5m"), 0)::bigint AS "cacheWrite5m",
        COALESCE(SUM(r."cacheWrite1h"), 0)::bigint AS "cacheWrite1h",
        COALESCE(SUM(r.reasoning), 0)::bigint AS reasoning,
        SUM(r."costUsd")::text AS "costUsd"
      FROM tree t LEFT JOIN llm_requests r ON r."sessionId" = t.id
      GROUP BY t.root`;
    return new Map(
      rows.map((r) => [
        r.root,
        {
          subagents: r.subagents,
          totals: {
            input: Number(r.input),
            output: Number(r.output),
            cacheRead: Number(r.cacheRead),
            cacheWrite5m: Number(r.cacheWrite5m),
            cacheWrite1h: Number(r.cacheWrite1h),
            reasoning: Number(r.reasoning),
            requests: r.requests,
            costUsd:
              r.costUsd === null
                ? null
                : new Prisma.Decimal(r.costUsd).toString(),
          },
        },
      ]),
    );
  }
}
