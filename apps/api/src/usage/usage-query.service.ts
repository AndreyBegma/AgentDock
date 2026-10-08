import {
  USAGE_BREAKDOWN_DEFAULT_LIMIT,
  type UsageBreakdownResponse,
  type UsageBreakdownRow,
  type UsageDimension,
  type UsageGroupBy,
  type UsagePoint,
  type UsageSeries,
  type UsageSummaryResponse,
  type UsageTimeseriesResponse,
  type UsageTotals,
} from '@agentdock/shared';
import type { Runtime } from '@agentdock/shared/protocol';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '../auth';
import { PrismaService } from '../database/prisma.service';
import { ProjectAccessService } from '../projects';
import type {
  UsageBreakdownDto,
  UsageRangeDto,
  UsageTimeseriesDto,
} from './dto';
import { usageError, usageProjectNotFound } from './usage-error';

type Caller = Pick<AuthUser, 'id' | 'role'>;

const DAY_MS = 86_400_000;
/** The longest range any route takes. */
const MAX_RANGE_DAYS = 400;
/** The longest range `interval=hour` takes: a month of points. */
const MAX_HOURLY_RANGE_DAYS = 31;

/** Sums of one group of rollup rows, as Postgres returns them. */
interface SumRow {
  requests: bigint;
  unpriced: bigint;
  input: bigint;
  output: bigint;
  cacheRead: bigint;
  cacheWrite5m: bigint;
  cacheWrite1h: bigint;
  reasoning: bigint;
  cost: string;
}

const SUMS = Prisma.sql`
  coalesce(sum(requests), 0)::bigint AS requests,
  coalesce(sum("unpricedRequests"), 0)::bigint AS unpriced,
  coalesce(sum(input), 0)::bigint AS input,
  coalesce(sum(output), 0)::bigint AS output,
  coalesce(sum("cacheRead"), 0)::bigint AS "cacheRead",
  coalesce(sum("cacheWrite5m"), 0)::bigint AS "cacheWrite5m",
  coalesce(sum("cacheWrite1h"), 0)::bigint AS "cacheWrite1h",
  coalesce(sum(reasoning), 0)::bigint AS reasoning,
  coalesce(sum("costUsd"), 0)::text AS cost`;

const toTotals = (row: SumRow): UsageTotals => ({
  requests: Number(row.requests),
  unpricedRequests: Number(row.unpriced),
  input: Number(row.input),
  output: Number(row.output),
  cacheRead: Number(row.cacheRead),
  cacheWrite5m: Number(row.cacheWrite5m),
  cacheWrite1h: Number(row.cacheWrite1h),
  reasoning: Number(row.reasoning),
  costUsd: new Prisma.Decimal(row.cost).toFixed(6),
});

const EMPTY: SumRow = {
  requests: 0n,
  unpriced: 0n,
  input: 0n,
  output: 0n,
  cacheRead: 0n,
  cacheWrite5m: 0n,
  cacheWrite1h: 0n,
  reasoning: 0n,
  cost: '0',
};

/** Every token once: reasoning is inside output (spec 12). */
const tokenCount = (t: UsageTotals): number =>
  t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;

const GROUP_COLUMN: Record<UsageGroupBy, Prisma.Sql> = {
  none: Prisma.sql`NULL::text`,
  project: Prisma.sql`"projectId"`,
  model: Prisma.sql`model`,
  runtime: Prisma.sql`runtime::text`,
};

const DIMENSION_COLUMN: Record<UsageDimension, Prisma.Sql> = {
  project: Prisma.sql`"projectId"`,
  model: Prisma.sql`model`,
  runtime: Prisma.sql`runtime::text`,
  issue: Prisma.sql`issue::text`,
  slot: Prisma.sql`slot`,
  run: Prisma.sql`"runId"`,
};

/** Dimensions that only mean something within a project. */
const PER_PROJECT: ReadonlySet<UsageDimension> = new Set([
  'issue',
  'slot',
  'run',
]);

const isTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/**
 * Reads `usage_rollups` (spec 13 API) under D9: a `projectId` the caller
 * cannot see is 404; without one, a non-admin sees their projects' usage and
 * never the project-less (machine-wide) kind, an admin sees everything.
 */
@Injectable()
export class UsageQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
  ) {}

  async summary(
    user: Caller,
    query: UsageRangeDto,
  ): Promise<UsageSummaryResponse> {
    const where = await this.where(user, query);
    const rows = await this.prisma.$queryRaw<
      Array<SumRow & { runtime: Runtime }>
    >`SELECT runtime::text AS runtime, ${SUMS}
      FROM usage_rollups WHERE ${where}
      GROUP BY runtime ORDER BY runtime`;
    const [total] = await this.prisma.$queryRaw<SumRow[]>`
      SELECT ${SUMS} FROM usage_rollups WHERE ${where}`;
    return {
      totals: toTotals(total ?? EMPTY),
      byRuntime: rows.map((r) => ({ runtime: r.runtime, ...toTotals(r) })),
    };
  }

  async timeseries(
    user: Caller,
    query: UsageTimeseriesDto,
  ): Promise<UsageTimeseriesResponse> {
    const interval = query.interval ?? 'hour';
    const groupBy = query.groupBy ?? 'none';
    const tz = query.tz ?? 'UTC';
    if (!isTimeZone(tz)) {
      throw usageError(400, 'invalid_range', `Unknown time zone ${tz}`);
    }
    const where = await this.where(user, query, {
      maxDays: interval === 'hour' ? MAX_HOURLY_RANGE_DAYS : MAX_RANGE_DAYS,
    });
    const from = new Date(query.from);
    const to = new Date(query.to);

    const bucket =
      interval === 'hour'
        ? Prisma.sql`hour`
        : Prisma.sql`(date_trunc('day', hour AT TIME ZONE ${tz}) AT TIME ZONE ${tz})`;
    const buckets =
      interval === 'hour'
        ? await this.prisma.$queryRaw<Array<{ t: Date }>>`
            SELECT generate_series(
              date_trunc('hour', ${from}::timestamptz, 'UTC'),
              ${to}::timestamptz - interval '1 millisecond',
              interval '1 hour') AS t`
        : await this.prisma.$queryRaw<Array<{ t: Date }>>`
            SELECT d AT TIME ZONE ${tz} AS t FROM generate_series(
              date_trunc('day', ${from}::timestamptz AT TIME ZONE ${tz}),
              (${to}::timestamptz - interval '1 millisecond') AT TIME ZONE ${tz},
              interval '1 day') AS d`;

    const rows = await this.prisma.$queryRaw<
      Array<SumRow & { t: Date; key: string | null }>
    >`SELECT ${bucket} AS t, ${GROUP_COLUMN[groupBy]} AS key, ${SUMS}
      FROM usage_rollups WHERE ${where}
      GROUP BY 1, 2 ORDER BY 1`;

    const byKey = new Map<string | null, Map<number, UsagePoint>>();
    for (const row of rows) {
      const totals = toTotals(row);
      const points = byKey.get(row.key) ?? new Map<number, UsagePoint>();
      points.set(row.t.getTime(), {
        t: row.t.toISOString(),
        costUsd: totals.costUsd,
        tokens: tokenCount(totals),
        requests: totals.requests,
        unpricedRequests: totals.unpricedRequests,
      });
      byKey.set(row.key, points);
    }
    if (groupBy === 'none' && byKey.size === 0) byKey.set(null, new Map());

    const labels =
      groupBy === 'project'
        ? await this.projectNames([...byKey.keys()])
        : new Map<string, string>();
    const series: UsageSeries[] = [...byKey].map(([key, points]) => ({
      key,
      label: key === null ? null : (labels.get(key) ?? key),
      points: buckets.map(
        ({ t }) =>
          points.get(t.getTime()) ?? {
            t: t.toISOString(),
            costUsd: '0.000000',
            tokens: 0,
            requests: 0,
            unpricedRequests: 0,
          },
      ),
    }));
    return { interval, groupBy, tz, series };
  }

  async breakdown(
    user: Caller,
    query: UsageBreakdownDto,
  ): Promise<UsageBreakdownResponse> {
    const where = await this.where(user, query);
    const key = DIMENSION_COLUMN[query.dimension];
    const perProject = PER_PROJECT.has(query.dimension);
    const project = perProject
      ? Prisma.sql`"projectId"`
      : Prisma.sql`NULL::text`;
    const rows = await this.prisma.$queryRaw<
      Array<SumRow & { key: string | null; project: string | null }>
    >`SELECT ${key} AS key, ${project} AS project, ${SUMS}
      FROM usage_rollups WHERE ${where}
      GROUP BY 1, 2
      ORDER BY sum("costUsd") DESC, sum(requests) DESC, 1 NULLS LAST
      LIMIT ${query.limit ?? USAGE_BREAKDOWN_DEFAULT_LIMIT}`;

    const names =
      query.dimension === 'project'
        ? await this.projectNames(rows.map((r) => r.key))
        : new Map<string, string>();
    const result: UsageBreakdownRow[] = rows.map((r) => ({
      ...toTotals(r),
      key: r.key,
      label: r.key === null ? null : (names.get(r.key) ?? r.key),
      projectId: query.dimension === 'project' ? r.key : r.project,
    }));
    return { dimension: query.dimension, rows: result };
  }

  /** The rows the caller may see in the range (D9, D10). */
  private async where(
    user: Caller,
    query: UsageRangeDto,
    { maxDays = MAX_RANGE_DAYS } = {},
  ): Promise<Prisma.Sql> {
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (from >= to) {
      throw usageError(400, 'invalid_range', 'from must be before to');
    }
    if (to.getTime() - from.getTime() > maxDays * DAY_MS) {
      throw usageError(
        400,
        'invalid_range',
        `The range may span at most ${maxDays} days`,
      );
    }
    // Rollups are hourly: the range starts at the UTC hour holding `from`.
    const range = Prisma.sql`hour >= date_trunc('hour', ${from}::timestamptz, 'UTC') AND hour < ${to}::timestamptz`;

    if (query.projectId) {
      if (!(await this.access.resolve(user, query.projectId))) {
        throw usageProjectNotFound();
      }
      return Prisma.sql`${range} AND "projectId" = ${query.projectId}`;
    }
    if (user.role === 'admin') return range;
    const memberships = await this.prisma.projectMember.findMany({
      where: { userId: user.id },
      select: { projectId: true },
    });
    const ids = memberships.map((m) => m.projectId);
    return Prisma.sql`${range} AND "projectId" = ANY(${ids}::text[])`;
  }

  private async projectNames(
    ids: Array<string | null>,
  ): Promise<Map<string, string>> {
    const wanted = ids.filter((id): id is string => id !== null);
    if (wanted.length === 0) return new Map();
    const rows = await this.prisma.project.findMany({
      where: { id: { in: wanted } },
      select: { id: true, displayName: true },
    });
    return new Map(rows.map((r) => [r.id, r.displayName]));
  }
}
