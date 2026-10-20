import {
  WORKFLOW_MAX_RANGE_DAYS,
  WORKFLOW_TOOLS_DEFAULT_LIMIT,
  type WorkflowsOrchestrationResponse,
  type WorkflowsSummaryResponse,
  type WorkflowsToolsResponse,
} from '@nautelle/shared';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '../auth';
import { PrismaService } from '../database/prisma.service';
import { ProjectAccessService } from '../projects';
import type { WorkflowsQueryDto, WorkflowsToolsQueryDto } from './dto';
import { workflowError, workflowProjectNotFound } from './workflow-error';
import {
  orchestration,
  scope,
  summarize,
  type TransitionSum,
  toolTransitions,
  topToolFlow,
  type WorkflowGroup,
} from './workflow-metrics';
import { bucketSql, durationMsSql, outcomeSql } from './workflow-sql';
import { WORKFLOWS_OPTIONS, type WorkflowsOptions } from './workflows-options';

type Caller = Pick<AuthUser, 'id' | 'role'>;

const DAY_MS = 86_400_000;
/** Responses kept at most; expired ones go first, then the oldest. */
const CACHE_MAX_ENTRIES = 500;

/** The groups in scope, and the SQL condition they were read with. */
interface Scoped {
  where: Prisma.Sql;
  groups: WorkflowGroup[];
  /** The page's filters dropped some groups of `where`. */
  narrowed: boolean;
}

/**
 * Reads `session_workflows` (#161) under the usage rule: a `projectId` the
 * caller cannot see is 404; without one, a non-admin sees their projects and
 * never the project-less sessions, an admin sees everything. Responses are
 * cached per caller visibility and query for `cacheTtlMs`.
 */
@Injectable()
export class WorkflowsQueryService {
  private readonly cache = new Map<
    string,
    { expires: number; value: Promise<unknown> }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
    @Inject(WORKFLOWS_OPTIONS) private readonly options: WorkflowsOptions,
  ) {}

  summary(
    user: Caller,
    query: WorkflowsQueryDto,
  ): Promise<WorkflowsSummaryResponse> {
    return this.cached(user, 'summary', query, async () => {
      const now = new Date();
      const scoped = await this.scoped(user, query, now);
      const sums = await this.transitions(scoped, now);
      return summarize(scoped.groups, topToolFlow(sums), now);
    });
  }

  orchestration(
    user: Caller,
    query: WorkflowsQueryDto,
  ): Promise<WorkflowsOrchestrationResponse> {
    return this.cached(user, 'orchestration', query, async () => {
      const now = new Date();
      const { groups } = await this.scoped(user, query, now);
      return orchestration(groups, now);
    });
  }

  tools(
    user: Caller,
    query: WorkflowsToolsQueryDto,
  ): Promise<WorkflowsToolsResponse> {
    return this.cached(user, 'tools', query, async () => {
      const now = new Date();
      const sums = await this.transitions(
        await this.scoped(user, query, now),
        now,
      );
      return {
        transitions: toolTransitions(
          sums,
          query.limit ?? WORKFLOW_TOOLS_DEFAULT_LIMIT,
        ),
        totalTransitions: sums.reduce((n, t) => n + t.count, 0),
        distinctTransitions: sums.length,
        computedAt: now.toISOString(),
      };
    });
  }

  /**
   * The root sessions in scope, as groups: SQL for range and visibility and
   * the grouping, then the page's filters over the groups.
   */
  private async scoped(
    user: Caller,
    query: WorkflowsQueryDto,
    now: Date,
  ): Promise<Scoped> {
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (from >= to) {
      throw workflowError(400, 'invalid_range', 'from must be before to');
    }
    if (to.getTime() - from.getTime() > WORKFLOW_MAX_RANGE_DAYS * DAY_MS) {
      throw workflowError(
        400,
        'invalid_range',
        `The range may span at most ${WORKFLOW_MAX_RANGE_DAYS} days`,
      );
    }
    const where = Prisma.join(
      [
        Prisma.sql`w."startedAt" >= ${from} AND w."startedAt" < ${to}`,
        await this.visibility(user, query.projectId),
        ...(query.runtime
          ? [Prisma.sql`w.runtime::text = ${query.runtime}`]
          : []),
        ...(query.profileKey
          ? [Prisma.sql`w."profileKey" = ${query.profileKey}`]
          : []),
      ],
      ' AND ',
    );
    const all = await this.prisma.$queryRaw<WorkflowGroup[]>`
      SELECT w.runtime::text AS runtime, w."primaryAgentType" AS "agentType",
        ${bucketSql} AS bucket, ${outcomeSql(now)} AS outcome,
        count(*)::int AS sessions, sum(w.depth)::int AS depth,
        sum(w.subagents)::int AS subagents, sum(w.compactions)::int AS compactions,
        sum(${durationMsSql})::float8 AS "durationMs"
      FROM session_workflows w WHERE ${where}
      GROUP BY 1, 2, 3, 4`;
    const groups = scope(all, query);
    return { where, groups, narrowed: groups.length < all.length };
  }

  /** The SQL condition on `session_workflows w` for what the caller may see. */
  private async visibility(
    user: Caller,
    projectId: string | undefined,
  ): Promise<Prisma.Sql> {
    if (projectId) {
      if (!(await this.access.resolve(user, projectId))) {
        throw workflowProjectNotFound();
      }
      return Prisma.sql`w."projectId" = ${projectId}`;
    }
    if (user.role === 'admin') return Prisma.sql`TRUE`;
    const memberships = await this.prisma.projectMember.findMany({
      where: { userId: user.id },
      select: { projectId: true },
    });
    const ids = memberships.map((m) => m.projectId);
    return Prisma.sql`w."projectId" = ANY(${ids}::text[])`;
  }

  /**
   * Every `from → to` pair of the sessions in scope, summed. When the page's
   * filters dropped some groups, only the kept groups' sessions count.
   */
  private async transitions(
    { where, groups, narrowed }: Scoped,
    now: Date,
  ): Promise<TransitionSum[]> {
    if (groups.length === 0) return [];
    const kept = narrowed
      ? Prisma.sql`AND (w.runtime::text, w."primaryAgentType", ${bucketSql}, ${outcomeSql(now)})
          IN (SELECT * FROM unnest(
            ${groups.map((g) => g.runtime)}::text[],
            ${groups.map((g) => g.agentType)}::text[],
            ${groups.map((g) => g.bucket)}::text[],
            ${groups.map((g) => g.outcome)}::text[]))`
      : Prisma.empty;
    return this.prisma.$queryRaw<TransitionSum[]>`
      SELECT t."from", t."to", sum(t.count)::int AS count, sum(t.errors)::int AS errors
      FROM session_tool_transitions t
      JOIN session_workflows w ON w."sessionId" = t."sessionId"
      WHERE ${where} ${kept}
      GROUP BY t."from", t."to"`;
  }

  /**
   * One computation per caller visibility, route and query within the TTL;
   * concurrent identical requests share it. A failure is not cached.
   */
  private cached<T>(
    user: Caller,
    route: string,
    query: object,
    compute: () => Promise<T>,
  ): Promise<T> {
    const ttl = this.options.cacheTtlMs;
    if (ttl <= 0) return compute();
    const viewer = user.role === 'admin' ? 'admin' : `user:${user.id}`;
    const key = `${viewer}\n${route}\n${canonical(query)}`;
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expires > now) return hit.value as Promise<T>;

    const value = compute();
    this.cache.set(key, { expires: now + ttl, value });
    value.catch(() => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key);
    });
    this.prune(now);
    return value;
  }

  private prune(now: number): void {
    if (this.cache.size <= CACHE_MAX_ENTRIES) return;
    for (const [key, entry] of this.cache) {
      if (entry.expires <= now) this.cache.delete(key);
    }
    // Insertion order is age order: drop the oldest beyond the cap.
    for (const key of this.cache.keys()) {
      if (this.cache.size <= CACHE_MAX_ENTRIES) break;
      this.cache.delete(key);
    }
  }

  /** Drops every cached response. */
  clearCache(): void {
    this.cache.clear();
  }
}

/** A query as a stable string: defined fields only, in key order. */
const canonical = (query: object): string =>
  JSON.stringify(
    Object.entries(query)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
