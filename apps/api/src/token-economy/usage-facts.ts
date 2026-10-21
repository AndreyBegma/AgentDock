import { Prisma } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service';
import { RUN_REQUESTS, RUN_SESSIONS } from '../history/run-usage';

/**
 * #746: the usage facts of one ended run or manual session — what
 * `run_usage_facts` stores. Token counts include the subagent sessions'
 * requests; `subagentCostUsd` is their part of `costUsd`.
 */
export interface UsageFact {
  input: bigint;
  output: bigint;
  cacheRead: bigint;
  cacheWrite5m: bigint;
  cacheWrite1h: bigint;
  /** Decimal string; null while no request is priced. */
  costUsd: string | null;
  unpricedRequests: number;
  compactions: number;
  /** The largest own request: input + cache read + cache writes. */
  peakContext: number;
  /** Own distinct turns, or own main-loop requests when none names a turn. */
  turns: number;
  subagentCostUsd: string | null;
}

interface UsageFactRow {
  key: string;
  input: bigint;
  output: bigint;
  cacheRead: bigint;
  cacheWrite5m: bigint;
  cacheWrite1h: bigint;
  costUsd: string | null;
  unpriced: number;
  peak: number;
  turns: number;
  subagentCostUsd: string | null;
}

/** Aggregates a `reqs (key, sub, l.*)` CTE per key. */
const FACT_COLUMNS = Prisma.sql`
  COALESCE(SUM(q.input), 0)::bigint AS input,
  COALESCE(SUM(q.output), 0)::bigint AS output,
  COALESCE(SUM(q."cacheRead"), 0)::bigint AS "cacheRead",
  COALESCE(SUM(q."cacheWrite5m"), 0)::bigint AS "cacheWrite5m",
  COALESCE(SUM(q."cacheWrite1h"), 0)::bigint AS "cacheWrite1h",
  SUM(q."costUsd")::text AS "costUsd",
  (COUNT(*) FILTER (WHERE q."costUsd" IS NULL))::int AS unpriced,
  COALESCE(MAX(q.input + q."cacheRead" + q."cacheWrite5m" + q."cacheWrite1h")
    FILTER (WHERE NOT q.sub), 0)::int AS peak,
  COALESCE(
    NULLIF(COUNT(DISTINCT q."turnId") FILTER (WHERE NOT q.sub), 0),
    COUNT(*) FILTER (WHERE NOT q.sub AND q."querySource" = 'main')
  )::int AS turns,
  (SUM(q."costUsd") FILTER (WHERE q.sub))::text AS "subagentCostUsd"`;

const usd = (v: string | null): string | null =>
  v === null ? null : new Prisma.Decimal(v).toFixed(6);

const toFact = (row: UsageFactRow, compactions: number): UsageFact => ({
  input: row.input,
  output: row.output,
  cacheRead: row.cacheRead,
  cacheWrite5m: row.cacheWrite5m,
  cacheWrite1h: row.cacheWrite1h,
  costUsd: usd(row.costUsd),
  unpricedRequests: row.unpriced,
  compactions,
  peakContext: row.peak,
  turns: row.turns,
  subagentCostUsd: usd(row.subagentCostUsd),
});

/** The distinct sessions of some runs, with each run's window. */
const ownSessions = (ids: Prisma.Sql) => Prisma.sql`
  SELECT DISTINCT r.id AS "runId", rs."sessionId", r."startedAt", r."endedAt"
  FROM runs r
  JOIN (${RUN_SESSIONS}) rs ON rs."runId" = r.id
  WHERE r.id IN (${ids})`;

/**
 * #746 D1: the usage facts of each run — the requests `usageByRun` counts
 * (`history/run-usage.ts`), plus, within the run's window, the requests of
 * every session whose `parentSessionId` chain leads to one of the run's
 * sessions; and the compactions of the run's own sessions within its window.
 * A run with no request is absent.
 */
export const usageFactsByRun = async (
  prisma: PrismaService,
  runIds: string[],
): Promise<Map<string, UsageFact>> => {
  if (runIds.length === 0) return new Map();
  const ids = Prisma.join(runIds);
  const [rows, compactions] = await Promise.all([
    prisma.$queryRaw<UsageFactRow[]>`
      WITH RECURSIVE own AS (${ownSessions(ids)}),
      tree AS (
        SELECT o."runId", se.id AS "sessionId", o."startedAt", o."endedAt"
        FROM own o
        JOIN sessions se ON se."parentSessionId" = o."sessionId"
        UNION
        SELECT t."runId", se.id, t."startedAt", t."endedAt"
        FROM tree t
        JOIN sessions se ON se."parentSessionId" = t."sessionId"
      ),
      reqs AS (
        SELECT r.id AS key, false AS sub, l.*
        ${RUN_REQUESTS}
        WHERE r.id IN (${ids})
        UNION ALL
        SELECT t."runId", true, l.*
        FROM (
          SELECT DISTINCT "runId", "sessionId", "startedAt", "endedAt" FROM tree
          WHERE ("runId", "sessionId") NOT IN (SELECT "runId", "sessionId" FROM own)
        ) t
        JOIN llm_requests l ON l."sessionId" = t."sessionId"
          AND l.ts >= t."startedAt" AND (t."endedAt" IS NULL OR l.ts <= t."endedAt")
      )
      SELECT q.key, ${FACT_COLUMNS}
      FROM reqs q
      GROUP BY q.key`,
    prisma.$queryRaw<{ key: string; count: number }[]>`
      SELECT o."runId" AS key, COUNT(c.id)::int AS count
      FROM (${ownSessions(ids)}) o
      JOIN session_compactions c ON c."sessionId" = o."sessionId"
        AND c.ts >= o."startedAt" AND (o."endedAt" IS NULL OR c.ts <= o."endedAt")
      GROUP BY o."runId"`,
  ]);
  const counts = new Map(compactions.map((c) => [c.key, c.count]));
  return new Map(
    rows.map((row) => [row.key, toFact(row, counts.get(row.key) ?? 0)]),
  );
};

/**
 * #746 D8: the usage facts of each manual session — all its requests, plus
 * those of its subagent sessions, and its compactions. A session with no
 * request is absent.
 */
export const usageFactsBySession = async (
  prisma: PrismaService,
  sessionIds: string[],
): Promise<Map<string, UsageFact>> => {
  if (sessionIds.length === 0) return new Map();
  const ids = Prisma.join(sessionIds);
  const [rows, compactions] = await Promise.all([
    prisma.$queryRaw<UsageFactRow[]>`
      WITH RECURSIVE tree AS (
        SELECT se.id AS root, se.id AS "sessionId", false AS sub
        FROM sessions se WHERE se.id IN (${ids})
        UNION
        SELECT t.root, se.id, true
        FROM tree t
        JOIN sessions se ON se."parentSessionId" = t."sessionId"
      ),
      reqs AS (
        SELECT t.root AS key, t.sub, l.*
        FROM tree t
        JOIN llm_requests l ON l."sessionId" = t."sessionId"
      )
      SELECT q.key, ${FACT_COLUMNS}
      FROM reqs q
      GROUP BY q.key`,
    prisma.sessionCompaction.groupBy({
      by: ['sessionId'],
      where: { sessionId: { in: sessionIds } },
      _count: { _all: true },
    }),
  ]);
  const counts = new Map(compactions.map((c) => [c.sessionId, c._count._all]));
  return new Map(
    rows.map((row) => [row.key, toFact(row, counts.get(row.key) ?? 0)]),
  );
};
