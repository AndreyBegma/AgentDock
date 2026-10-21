import type { RunUsage } from '@nautelle/shared';
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
 *   has no `projectId` to match on;
 * - a design turn (#243 D2, #480): the card's or the stack's design session
 *   (`designSessionId`), by its id on the project's runner. Its plan turn
 *   names the card or the stack instead of a plan (#663).
 * - a board card round (issue #242 D4): the card's Claude session, by its id
 *   on the project's runner. Every round resumes the same session, so the
 *   run's window is what splits its requests between rounds.
 * - a card capture extraction (issue #244 D4): the Claude session the API
 *   assigned it (`card_captures.extractSessionId`), by its id on the
 *   project's runner; it runs in a run directory outside every root.
 * - a text normalization (issue #271): the Claude session the API assigned
 *   it (`text_normalizations.sessionId`), the same way.
 * Skill runs record no session id, so they have no usage yet.
 */
export const RUN_SESSIONS = Prisma.sql`
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
    AND se2."externalId" = COALESCE(t."sessionId", p."sessionId")::text
  UNION ALL
  SELECT pt."runId", se2.id
  FROM plan_turns pt
  JOIN board_cards c ON c.id = pt."cardId"
  JOIN projects pr ON pr.id = c."projectId"
  JOIN sessions se2 ON se2."runnerId" = pr."runnerId"
    AND se2.runtime = 'claude'
    AND se2."externalId" = c."designSessionId"::text
  UNION ALL
  SELECT pt."runId", se2.id
  FROM plan_turns pt
  JOIN board_stacks st ON st.id = pt."stackId"
  JOIN projects pr ON pr.id = st."projectId"
  JOIN sessions se2 ON se2."runnerId" = pr."runnerId"
    AND se2.runtime = 'claude'
    AND se2."externalId" = st."designSessionId"::text
  UNION ALL
  SELECT cr."runId", se2.id
  FROM board_card_rounds cr
  JOIN board_cards c ON c.id = cr."cardId"
  JOIN projects pr ON pr.id = c."projectId"
  JOIN sessions se2 ON se2."runnerId" = pr."runnerId"
    AND se2.runtime = 'claude'
    AND se2."externalId" = c."sessionId"::text
  UNION ALL
  SELECT cc."runId", se2.id
  FROM card_captures cc
  JOIN projects pr ON pr.id = cc."projectId"
  JOIN sessions se2 ON se2."runnerId" = pr."runnerId"
    AND se2.runtime = 'claude'
    AND se2."externalId" = cc."extractSessionId"::text
  WHERE cc."runId" IS NOT NULL
  UNION ALL
  SELECT tn."runId", se2.id
  FROM text_normalizations tn
  JOIN projects pr ON pr.id = tn."projectId"
  JOIN sessions se2 ON se2."runnerId" = pr."runnerId"
    AND se2.runtime = 'claude'
    AND se2."externalId" = tn."sessionId"::text
  WHERE tn."runId" IS NOT NULL`;

/**
 * The requests of a run (spec 21 D8): of its sessions, the `llm_requests`
 * within the run's window. `usage_rollups` are not needed; when runs get a
 * `runId` on their requests (#13 D14) this join is the one place to change.
 */
export const RUN_REQUESTS = Prisma.sql`
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

/**
 * #445: the model each run's session actually ran on — the one with the most
 * input tokens among its requests; a run with no request is absent.
 */
export const sessionModelByRun = async (
  prisma: PrismaService,
  runIds: string[],
): Promise<Map<string, string>> => {
  if (runIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<{ key: string; model: string }[]>`
    SELECT DISTINCT ON (r.id) r.id AS key, l.model
    ${RUN_REQUESTS}
    WHERE r.id IN (${Prisma.join(runIds)})
    GROUP BY r.id, l.model
    ORDER BY r.id, SUM(l.input) DESC, l.model`;
  return new Map(rows.map((row) => [row.key, row.model]));
};

/** #445 D12: runs of one kind on one side of the token saver. */
export interface RunCostGroup {
  kind: string;
  tokenSaver: boolean;
  runs: number;
  /** Average over the priced runs, a decimal string; null when none is priced. */
  avgUsd: string | null;
}

/**
 * #445 D12: the ended runs of a project started in `[from, to)`, grouped by
 * kind and by `runs.tokenSaver` — the before/after is these two sides, never
 * a date.
 */
export const runCostsByKind = async (
  prisma: PrismaService,
  projectId: string,
  kinds: readonly string[],
  from: Date,
  to: Date,
): Promise<RunCostGroup[]> => {
  if (kinds.length === 0) return [];
  const rows = await prisma.$queryRaw<
    { kind: string; tokenSaver: boolean; runs: number; avgUsd: string | null }[]
  >`
    SELECT r.kind::text AS kind, r."tokenSaver" AS "tokenSaver",
      COUNT(*)::int AS runs, AVG(c.cost)::text AS "avgUsd"
    FROM runs r
    LEFT JOIN (
      SELECT r.id, SUM(l."costUsd") AS cost
      ${RUN_REQUESTS}
      WHERE r."projectId" = ${projectId}
        AND r."startedAt" >= ${from} AND r."startedAt" < ${to}
      GROUP BY r.id
    ) c ON c.id = r.id
    WHERE r."projectId" = ${projectId}
      AND r."startedAt" >= ${from} AND r."startedAt" < ${to}
      AND r."endedAt" IS NOT NULL
      AND r.kind::text IN (${Prisma.join([...kinds])})
    GROUP BY r.kind, r."tokenSaver"`;
  return rows.map((row) => ({
    ...row,
    avgUsd:
      row.avgUsd === null ? null : new Prisma.Decimal(row.avgUsd).toFixed(6),
  }));
};

/**
 * #663 D5: the rounds of one session kind in one ISO week. `kind` is a run's
 * kind refined: a card round started for CI is `ci_fix`, a design turn is
 * `design`, a worker slot is `worker`.
 */
export interface RoundCostGroup {
  kind: string;
  /** The Monday of the UTC ISO week the round started in, `YYYY-MM-DD`. */
  week: string;
  rounds: number;
  pricedRounds: number;
  /** Decimal strings over the priced rounds; null when none is priced. */
  medianUsd: string | null;
  p90Usd: string | null;
  input: number;
  cacheRead: number;
  /** 5-minute and 1-hour writes together. */
  cacheWrite: number;
  medianPeakContext: number;
  medianTurns: number;
}

export interface RoundCostRow {
  kind: string;
  week: string;
  rounds: number;
  pricedRounds: number;
  medianUsd: string | null;
  p90Usd: string | null;
  input: bigint;
  cacheRead: bigint;
  cacheWrite: bigint;
  medianPeakContext: number | null;
  medianTurns: number | null;
}

/**
 * Aggregates a per-round CTE `rounds (kind, week, cost, input, "cacheRead",
 * "cacheWrite", peak, turns)` by kind and week.
 */
export const ROUND_COST_COLUMNS = Prisma.sql`
  kind, week, COUNT(*)::int AS rounds,
  COUNT(cost)::int AS "pricedRounds",
  (percentile_cont(0.5) WITHIN GROUP (ORDER BY cost))::text AS "medianUsd",
  (percentile_cont(0.9) WITHIN GROUP (ORDER BY cost))::text AS "p90Usd",
  COALESCE(SUM(input), 0)::bigint AS input,
  COALESCE(SUM("cacheRead"), 0)::bigint AS "cacheRead",
  COALESCE(SUM("cacheWrite"), 0)::bigint AS "cacheWrite",
  (percentile_cont(0.5) WITHIN GROUP (ORDER BY peak))::float8 AS "medianPeakContext",
  (percentile_cont(0.5) WITHIN GROUP (ORDER BY turns))::float8 AS "medianTurns"`;

/** The UTC ISO week of a timestamp column, as its Monday `YYYY-MM-DD`. */
export const isoWeekOf = (column: Prisma.Sql): Prisma.Sql =>
  Prisma.sql`to_char(date_trunc('week', ${column} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;

export const toRoundCostGroup = (row: RoundCostRow): RoundCostGroup => {
  const usd = (v: string | null) =>
    v === null ? null : new Prisma.Decimal(v).toFixed(6);
  return {
    kind: row.kind,
    week: row.week,
    rounds: row.rounds,
    pricedRounds: row.pricedRounds,
    medianUsd: usd(row.medianUsd),
    p90Usd: usd(row.p90Usd),
    input: Number(row.input),
    cacheRead: Number(row.cacheRead),
    cacheWrite: Number(row.cacheWrite),
    medianPeakContext: Math.round(row.medianPeakContext ?? 0),
    medianTurns: row.medianTurns ?? 0,
  };
};

/**
 * #663 D5: cost per round of a project's ended runs started in `[from, to)`,
 * by refined kind and ISO week — from the same requests `usageByRun` counts.
 * A round is a run with at least one request. Its peak context is its largest
 * request (input + cache read + cache write); its turns are its distinct
 * turns, or its main-loop requests when no request names a turn.
 */
export const roundCostsByKind = async (
  prisma: PrismaService,
  projectId: string,
  from: Date,
  to: Date,
): Promise<RoundCostGroup[]> => {
  const rows = await prisma.$queryRaw<RoundCostRow[]>`
    WITH rounds AS (
      SELECT
        CASE
          WHEN r.kind = 'card' AND cr.trigger = 'ci_fix' THEN 'ci_fix'
          WHEN r.kind = 'plan' AND pt."planId" IS NULL THEN 'design'
          WHEN r.kind = 'orchestrator_slot' THEN 'worker'
          ELSE r.kind::text
        END AS kind,
        ${isoWeekOf(Prisma.sql`r."startedAt"`)} AS week,
        SUM(l."costUsd") AS cost,
        SUM(l.input) AS input,
        SUM(l."cacheRead") AS "cacheRead",
        SUM(l."cacheWrite5m" + l."cacheWrite1h") AS "cacheWrite",
        MAX(l.input + l."cacheRead" + l."cacheWrite5m" + l."cacheWrite1h") AS peak,
        COALESCE(
          NULLIF(COUNT(DISTINCT l."turnId"), 0),
          COUNT(*) FILTER (WHERE l."querySource" = 'main')
        ) AS turns
      ${RUN_REQUESTS}
      LEFT JOIN board_card_rounds cr ON cr."runId" = r.id
      LEFT JOIN plan_turns pt ON pt."runId" = r.id
      WHERE r."projectId" = ${projectId}
        AND r."startedAt" >= ${from} AND r."startedAt" < ${to}
        AND r."endedAt" IS NOT NULL
      GROUP BY r.id, cr.trigger, pt."planId"
    )
    SELECT ${ROUND_COST_COLUMNS}
    FROM rounds
    GROUP BY kind, week`;
  return rows.map(toRoundCostGroup);
};

/** #648: the prompt cache of the ended runs of one kind. */
export interface RunPromptCacheGroup {
  kind: string;
  /** Runs with at least one request. */
  runs: number;
  input: number;
  cacheRead: number;
  /** 5-minute and 1-hour writes together. */
  cacheWrite: number;
}

/**
 * #648: what the prompt cache did for the ended runs of a project started in
 * `[from, to)`, by kind — summed from their requests (ADR-0003), the same
 * requests `usageByRun` counts.
 */
export const runPromptCacheByKind = async (
  prisma: PrismaService,
  projectId: string,
  kinds: readonly string[],
  from: Date,
  to: Date,
): Promise<RunPromptCacheGroup[]> => {
  if (kinds.length === 0) return [];
  const rows = await prisma.$queryRaw<
    {
      kind: string;
      runs: number;
      input: bigint;
      cacheRead: bigint;
      cacheWrite: bigint;
    }[]
  >`
    SELECT r.kind::text AS kind, COUNT(DISTINCT r.id)::int AS runs,
      COALESCE(SUM(l.input), 0)::bigint AS input,
      COALESCE(SUM(l."cacheRead"), 0)::bigint AS "cacheRead",
      COALESCE(SUM(l."cacheWrite5m" + l."cacheWrite1h"), 0)::bigint AS "cacheWrite"
    ${RUN_REQUESTS}
    WHERE r."projectId" = ${projectId}
      AND r."startedAt" >= ${from} AND r."startedAt" < ${to}
      AND r."endedAt" IS NOT NULL
      AND r.kind::text IN (${Prisma.join([...kinds])})
    GROUP BY r.kind`;
  return rows.map((row) => ({
    kind: row.kind,
    runs: row.runs,
    input: Number(row.input),
    cacheRead: Number(row.cacheRead),
    cacheWrite: Number(row.cacheWrite),
  }));
};
