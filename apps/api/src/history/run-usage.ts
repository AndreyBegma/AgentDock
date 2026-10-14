import type { RunUsage } from '@agentdock/shared';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service';

interface UsageRow {
  key: string;
  requests: number;
  unpriced: number;
  input: bigint;
  output: bigint;
  cacheRead: bigint;
  cacheWrite5m: bigint;
  cacheWrite1h: bigint;
  reasoning: bigint;
  costUsd: string | null;
}

export const EMPTY_USAGE: RunUsage = {
  requests: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  reasoning: 0,
  costUsd: null,
  unpricedRequests: 0,
};

/**
 * The sessions of each run (#12):
 * - a slot run (spec 21 D8): its slot's sessions, by `(projectId, slotName)`;
 * - a plan turn (spec 172 D14): the Claude session it ran in — the task's
 *   fork for a task turn, else the plan's — by its id on the project's
 *   runner. The plan worktree sits outside the project root, so the session
 *   has no `projectId` to match on.
 * Skill runs record no session id, so they have no usage yet.
 */
const RUN_SESSIONS = Prisma.sql`
  SELECT r2.id AS "runId", se2.id AS "sessionId"
  FROM runs r2
  JOIN slots s ON s.id = r2."slotId"
  JOIN sessions se2 ON se2."projectId" = r2."projectId" AND se2."slotName" = s.name
  UNION ALL
  SELECT pt."runId", se2.id
  FROM plan_turns pt
  JOIN plans p ON p.id = pt."planId"
  LEFT JOIN plan_tasks t ON t.id = pt."taskId"
  JOIN projects pr ON pr.id = p."projectId"
  JOIN sessions se2 ON se2."runnerId" = pr."runnerId"
    AND se2.runtime = 'claude'
    AND se2."externalId" = COALESCE(t."sessionId", p."sessionId")::text`;

/**
 * The requests of a run (spec 21 D8): of its sessions, the `llm_requests`
 * within the run's window. `usage_rollups` are not needed; when runs get a
 * `runId` on their requests (#13 D14) this join is the one place to change.
 */
const RUN_REQUESTS = Prisma.sql`
  FROM runs r
  JOIN (${RUN_SESSIONS}) rs ON rs."runId" = r.id
  JOIN sessions se ON se.id = rs."sessionId"
  JOIN llm_requests l ON l."sessionId" = se.id
    AND l.ts >= r."startedAt" AND (r."endedAt" IS NULL OR l.ts <= r."endedAt")`;

const USAGE_COLUMNS = Prisma.sql`
  COUNT(l.id)::int AS requests,
  (COUNT(l.id) FILTER (WHERE l."costUsd" IS NULL))::int AS unpriced,
  COALESCE(SUM(l.input), 0)::bigint AS input,
  COALESCE(SUM(l.output), 0)::bigint AS output,
  COALESCE(SUM(l."cacheRead"), 0)::bigint AS "cacheRead",
  COALESCE(SUM(l."cacheWrite5m"), 0)::bigint AS "cacheWrite5m",
  COALESCE(SUM(l."cacheWrite1h"), 0)::bigint AS "cacheWrite1h",
  COALESCE(SUM(l.reasoning), 0)::bigint AS reasoning,
  SUM(l."costUsd")::text AS "costUsd"`;

const toUsage = (row: UsageRow): RunUsage => ({
  requests: row.requests,
  input: Number(row.input),
  output: Number(row.output),
  cacheRead: Number(row.cacheRead),
  cacheWrite5m: Number(row.cacheWrite5m),
  cacheWrite1h: Number(row.cacheWrite1h),
  reasoning: Number(row.reasoning),
  // Sums the priced requests; null while none is priced (#13).
  costUsd:
    row.costUsd === null ? null : new Prisma.Decimal(row.costUsd).toFixed(6),
  unpricedRequests: row.unpriced,
});

/** Usage of each run; a run with no request is absent (use `EMPTY_USAGE`). */
export const usageByRun = async (
  prisma: PrismaService,
  runIds: string[],
): Promise<Map<string, RunUsage>> => {
  if (runIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<UsageRow[]>`
    SELECT r.id AS key, ${USAGE_COLUMNS}
    ${RUN_REQUESTS}
    WHERE r.id IN (${Prisma.join(runIds)})
    GROUP BY r.id`;
  return new Map(rows.map((row) => [row.key, toUsage(row)]));
};

/** Usage of each session of one run, within the run's window. */
export const usageBySession = async (
  prisma: PrismaService,
  runId: string,
): Promise<Map<string, RunUsage>> => {
  const rows = await prisma.$queryRaw<UsageRow[]>`
    SELECT se.id AS key, ${USAGE_COLUMNS}
    ${RUN_REQUESTS}
    WHERE r.id = ${runId}
    GROUP BY se.id`;
  return new Map(rows.map((row) => [row.key, toUsage(row)]));
};
