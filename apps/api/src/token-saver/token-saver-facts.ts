import type {
  EstimateCachePrices,
  TokenSavedView,
  TokenSaverFilterSavings,
  TokenSaverRunKind,
  TokenSaverUnfilteredProgram,
} from '@nautelle/shared';
import {
  estimateUsdSaved,
  FILTER_ID_NONE,
  FILTER_ID_NONE_COMPOUND,
  FILTER_ID_NONE_MODE,
  FILTER_ID_NONE_UNCOVERED,
  TOKEN_SAVER_BYTES_PER_TOKEN,
  TOKEN_SAVER_UNFILTERED_PROGRAMS_MAX,
} from '@nautelle/shared';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service';
import {
  RUN_REQUESTS,
  sessionModelByRun,
  usageByRun,
} from '../history/run-usage';
import { toModelPrice } from '../prices/cost.service';
import { compilePrices, matchModel } from '../prices/pricing';

/**
 * One group of `token_saver_stats` rows. `tokens` is the sum of each row's
 * estimate (shared `estimateTokensSaved`: (raw − kept) / 4, rounded), so a
 * group's total is the sum of its commands' estimates. `turnTokens` is the
 * sum of each row's tokens × its turns remaining (#746 D6), so the group
 * prices as `tokens × write + turnTokens × read`.
 */
export interface StatGroup {
  runId: string | null;
  /**
   * #748: the manual session the rows belong to — the stored one, else the
   * project's session of the same external id. Null on rows of a run.
   */
  sessionId: string | null;
  runKind: TokenSaverRunKind;
  filter: string;
  /** UTC day `YYYY-MM-DD`. */
  day: string;
  commands: number;
  rawBytes: number;
  keptBytes: number;
  bypassed: number;
  passedThrough: number;
  tokens: number;
  turnTokens: number;
}

interface StatGroupRow {
  runId: string | null;
  sessionId: string | null;
  runKind: TokenSaverRunKind;
  filter: string;
  day: string;
  commands: number;
  rawBytes: bigint;
  keptBytes: bigint;
  bypassed: number;
  passedThrough: number;
  tokens: bigint;
  turnTokens: bigint;
}

const ROW_TOKENS = Prisma.sql`GREATEST(0, ROUND((s."rawBytes" - s."keptBytes")::numeric / ${TOKEN_SAVER_BYTES_PER_TOKEN}))`;

const STAT_GROUP_COLUMNS = Prisma.sql`
  s."runId", s."effSession" AS "sessionId", s."runKind"::text AS "runKind", s.filter,
  to_char(s."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
  COUNT(*)::int AS commands,
  COALESCE(SUM(s."rawBytes"), 0)::bigint AS "rawBytes",
  COALESCE(SUM(s."keptBytes"), 0)::bigint AS "keptBytes",
  (COUNT(*) FILTER (WHERE s.bypassed))::int AS bypassed,
  (COUNT(*) FILTER (WHERE s."passedThrough"))::int AS "passedThrough",
  COALESCE(SUM(${ROW_TOKENS}), 0)::bigint AS tokens,
  COALESCE(SUM(${ROW_TOKENS} * t.turns), 0)::bigint AS "turnTokens"`;

/**
 * #746 D6: each picked row's turns remaining — the main-loop requests of its
 * run after the row, up to the next compaction of the run's sessions. A run
 * without requests has none (the estimate is the cache write only); a row
 * outside its run's first..last request cannot be placed on the timeline and
 * takes half the run's main-loop requests, rounded down. `picked` is a CTE of
 * `token_saver_stats` rows.
 *
 * #748: a manual row has no run; its subject is its session instead (the
 * stored `sessionId`, else the project's session of the same external id —
 * never another project's), and the same rule runs over the session's own
 * requests and compactions. `picked.effSession` is that session; `subject`
 * is the run id, else `s:<session id>`.
 */
const withTurns = (picked: Prisma.Sql): Prisma.Sql => Prisma.sql`
  WITH raw AS (${picked}),
  picked AS (
    SELECT e.*, COALESCE(e."runId", 's:' || e."effSession") AS subject
    FROM (
      SELECT s.*,
        CASE WHEN s."runId" IS NOT NULL THEN NULL ELSE COALESCE(s."sessionId", (
          SELECT se.id FROM sessions se
          JOIN projects pr ON pr.id = s."projectId"
          WHERE se."runnerId" = pr."runnerId" AND se.runtime = 'claude'
            AND se."externalId" = s."sessionExternalId"
            AND se."projectId" = s."projectId"
        )) END AS "effSession"
      FROM raw s
    ) e
  ),
  run_requests AS (
    SELECT r.id AS subject, se.id AS "sessionId", l.ts, l."querySource"
    ${RUN_REQUESTS}
    WHERE r.id IN (SELECT DISTINCT "runId" FROM picked WHERE "runId" IS NOT NULL)
    UNION ALL
    SELECT 's:' || se.id, se.id, l.ts, l."querySource"
    FROM sessions se
    JOIN llm_requests l ON l."sessionId" = se.id
    WHERE se.id IN (SELECT DISTINCT "effSession" FROM picked WHERE "effSession" IS NOT NULL)
  ),
  bounds AS (
    SELECT subject, MIN(ts) AS first, MAX(ts) AS last,
      (COUNT(*) FILTER (WHERE "querySource" = 'main'))::int AS main
    FROM run_requests GROUP BY subject
  ),
  turns AS (
    SELECT p.id,
      CASE
        WHEN b.subject IS NULL THEN 0
        WHEN p."createdAt" < b.first OR p."createdAt" > b.last THEN b.main / 2
        ELSE (
          SELECT COUNT(*)::int FROM run_requests q
          WHERE q.subject = p.subject AND q."querySource" = 'main'
            AND q.ts > p."createdAt"
            AND q.ts < COALESCE((
              SELECT MIN(c.ts) FROM session_compactions c
              WHERE c.ts > p."createdAt"
                AND c."sessionId" IN (
                  SELECT q2."sessionId" FROM run_requests q2
                  WHERE q2.subject = p.subject
                )
            ), 'infinity'::timestamp)
        )
      END AS turns
    FROM picked p
    LEFT JOIN bounds b ON b.subject = p.subject
  )`;

const toGroup = (row: StatGroupRow): StatGroup => ({
  ...row,
  rawBytes: Number(row.rawBytes),
  keptBytes: Number(row.keptBytes),
  tokens: Number(row.tokens),
  turnTokens: Number(row.turnTokens),
});

/** The stats of some runs, grouped by run, filter and day. */
export const statGroupsOfRuns = async (
  prisma: PrismaService,
  runIds: string[],
): Promise<StatGroup[]> => {
  if (runIds.length === 0) return [];
  const rows = await prisma.$queryRaw<StatGroupRow[]>`
    ${withTurns(Prisma.sql`
      SELECT * FROM token_saver_stats
      WHERE "runId" IN (${Prisma.join(runIds)})`)}
    SELECT ${STAT_GROUP_COLUMNS}
    FROM picked s
    JOIN turns t ON t.id = s.id
    GROUP BY 1, 2, 3, 4, 5`;
  return rows.map(toGroup);
};

/** The stats of a project in `[from, to)`, grouped by run, filter and day. */
export const statGroupsOfProject = async (
  prisma: PrismaService,
  projectId: string,
  from: Date,
  to: Date,
): Promise<StatGroup[]> => {
  const rows = await prisma.$queryRaw<StatGroupRow[]>`
    ${withTurns(Prisma.sql`
      SELECT * FROM token_saver_stats
      WHERE "projectId" = ${projectId}
        AND "createdAt" >= ${from} AND "createdAt" < ${to}`)}
    SELECT ${STAT_GROUP_COLUMNS}
    FROM picked s
    JOIN turns t ON t.id = s.id
    GROUP BY 1, 2, 3, 4, 5`;
  return rows.map(toGroup);
};

/**
 * #748 D1: the stats of some tracked sessions, grouped by filter and day. A
 * row belongs to a session by its stored `sessionId`, else by its external id
 * when the row's project is the session's — a batch from another project's
 * root never reaches the session's card (D4).
 */
export const statGroupsOfSessions = async (
  prisma: PrismaService,
  sessionIds: string[],
): Promise<StatGroup[]> => {
  if (sessionIds.length === 0) return [];
  const rows = await prisma.$queryRaw<StatGroupRow[]>`
    ${withTurns(Prisma.sql`
      SELECT t.* FROM token_saver_stats t
      WHERE t."runId" IS NULL AND (
        t."sessionId" IN (${Prisma.join(sessionIds)})
        OR (t."sessionId" IS NULL AND EXISTS (
          SELECT 1 FROM sessions se
          JOIN projects pr ON pr.id = t."projectId"
          WHERE se.id IN (${Prisma.join(sessionIds)})
            AND se."runnerId" = pr."runnerId" AND se.runtime = 'claude'
            AND se."externalId" = t."sessionExternalId"
            AND se."projectId" = t."projectId"
        ))
      )`)}
    SELECT ${STAT_GROUP_COLUMNS}
    FROM picked s
    JOIN turns t ON t.id = s.id
    GROUP BY 1, 2, 3, 4, 5`;
  return rows.map(toGroup);
};

/**
 * #648: the programs of a project's unfiltered commands in `[from, to)` — the
 * `none` and `none:*` rows that name one — most commands first.
 */
export const unfilteredProgramsOfProject = async (
  prisma: PrismaService,
  projectId: string,
  from: Date,
  to: Date,
): Promise<TokenSaverUnfilteredProgram[]> => {
  const rows = await prisma.tokenSaverStat.groupBy({
    by: ['program'],
    where: {
      projectId,
      createdAt: { gte: from, lt: to },
      program: { not: null },
      filter: {
        in: [
          FILTER_ID_NONE,
          FILTER_ID_NONE_COMPOUND,
          FILTER_ID_NONE_UNCOVERED,
          FILTER_ID_NONE_MODE,
        ],
      },
    },
    _count: { _all: true },
    orderBy: [{ _count: { program: 'desc' } }, { program: 'asc' }],
    take: TOKEN_SAVER_UNFILTERED_PROGRAMS_MAX,
  });
  return rows.flatMap((r) =>
    r.program === null ? [] : [{ program: r.program, commands: r._count._all }],
  );
};

/**
 * #746 D6 (ADR-0074 §5): the cache prices (USD per token) of each run's
 * session model, from the default tier of the newest price version (ADR-0009).
 * `write` is the 1-hour write price when the run's requests wrote with the
 * 1-hour TTL, else the 5-minute one. A bucket without a price falls back as
 * the price table does: 1h → 5m → input, read → input. A run without
 * requests falls back to `runs.model`; an unpriced one is absent (prices at 0).
 */
export const cachePricesOfRuns = async (
  prisma: PrismaService,
  runIds: string[],
): Promise<Map<string, EstimateCachePrices>> => {
  if (runIds.length === 0) return new Map();
  const [sessionModels, usage, runs, priceOf] = await Promise.all([
    sessionModelByRun(prisma, runIds),
    usageByRun(prisma, runIds),
    prisma.run.findMany({
      where: { id: { in: runIds } },
      select: { id: true, model: true },
    }),
    cachePriceLookup(prisma),
  ]);
  const out = new Map<string, EstimateCachePrices>();
  for (const run of runs) {
    const model = sessionModels.get(run.id) ?? run.model;
    if (model === null) continue;
    const price = priceOf(model, (usage.get(run.id)?.cacheWrite1h ?? 0) > 0);
    if (price !== undefined) out.set(run.id, price);
  }
  return out;
};

/** The default tier's cache prices of a model in the newest price version. */
const cachePriceLookup = async (
  prisma: PrismaService,
): Promise<
  (model: string, wrote1h: boolean) => EstimateCachePrices | undefined
> => {
  const head = await prisma.priceVersion.findFirst({
    orderBy: { number: 'desc' },
    select: {
      models: {
        select: {
          modelName: true,
          matchPattern: true,
          priority: true,
          tiers: true,
        },
      },
    },
  });
  const prices = compilePrices((head?.models ?? []).map(toModelPrice));
  return (model, wrote1h) => {
    const tier = matchModel(prices, model)?.tiers.find((t) => t.isDefault);
    if (tier === undefined) return undefined;
    const p = tier.prices;
    const write5m = p.cacheWrite5m ?? p.input;
    const write1h = p.cacheWrite1h ?? write5m;
    return {
      write: wrote1h ? write1h : write5m,
      read: p.cacheRead ?? p.input,
    };
  };
};

/**
 * #748 D3: the cache prices of each manual session, by the session's own
 * model — its last request's model, else the first of `sessions.models` — with
 * the 1-hour write price when any of its requests wrote with the 1-hour TTL.
 * A session with no known model is absent (prices at 0).
 */
export const cachePricesOfSessions = async (
  prisma: PrismaService,
  sessionIds: string[],
): Promise<Map<string, EstimateCachePrices>> => {
  if (sessionIds.length === 0) return new Map();
  const [sessions, last, wrote, priceOf] = await Promise.all([
    prisma.agentSession.findMany({
      where: { id: { in: sessionIds } },
      select: { id: true, models: true },
    }),
    prisma.$queryRaw<{ key: string; model: string }[]>`
      SELECT DISTINCT ON (l."sessionId") l."sessionId" AS key, l.model
      FROM llm_requests l
      WHERE l."sessionId" IN (${Prisma.join(sessionIds)})
      ORDER BY l."sessionId", l.ts DESC`,
    prisma.llmRequest.groupBy({
      by: ['sessionId'],
      where: { sessionId: { in: sessionIds }, cacheWrite1h: { gt: 0 } },
    }),
    cachePriceLookup(prisma),
  ]);
  const lastModel = new Map(last.map((r) => [r.key, r.model]));
  const wrote1h = new Set(wrote.map((r) => r.sessionId));
  const out = new Map<string, EstimateCachePrices>();
  for (const session of sessions) {
    const first = Array.isArray(session.models) ? session.models[0] : undefined;
    const model =
      lastModel.get(session.id) ?? (typeof first === 'string' ? first : null);
    if (model === null) continue;
    const price = priceOf(model, wrote1h.has(session.id));
    if (price !== undefined) out.set(sessionPriceKey(session.id), price);
  }
  return out;
};

/** The price-map key of a manual session; a run's is its id. */
export const sessionPriceKey = (sessionId: string): string => `s:${sessionId}`;

/** The price-map key of a group: its run, else its manual session. */
export const priceKeyOf = (g: StatGroup): string | null =>
  g.runId ?? (g.sessionId === null ? null : sessionPriceKey(g.sessionId));

/** The cache prices of every run and manual session the groups belong to. */
export const cachePricesOfGroups = async (
  prisma: PrismaService,
  groups: readonly StatGroup[],
): Promise<Map<string, EstimateCachePrices>> => {
  const runIds = new Set<string>();
  const sessionIds = new Set<string>();
  for (const g of groups) {
    if (g.runId !== null) runIds.add(g.runId);
    else if (g.sessionId !== null) sessionIds.add(g.sessionId);
  }
  const [byRun, bySession] = await Promise.all([
    cachePricesOfRuns(prisma, [...runIds]),
    cachePricesOfSessions(prisma, [...sessionIds]),
  ]);
  return new Map([...byRun, ...bySession]);
};

/**
 * The estimate of some groups, each priced at its run's — else its manual
 * session's (#748) — cache prices over its rows' turns remaining (#746 D6).
 * A group of neither prices at 0.
 */
export const savedOf = (
  groups: readonly StatGroup[],
  prices: ReadonlyMap<string, EstimateCachePrices>,
): TokenSavedView => {
  let estimateTokens = 0;
  let estimateUsd = 0;
  for (const g of groups) {
    estimateTokens += g.tokens;
    const key = priceKeyOf(g);
    const price = key === null ? undefined : prices.get(key);
    if (price === undefined || g.tokens === 0) continue;
    // Σ tokensᵢ × (write + read × turnsᵢ) = tokens × (write + read × turnTokens / tokens).
    estimateUsd += estimateUsdSaved(g.tokens, price, g.turnTokens / g.tokens);
  }
  return { estimateTokens, estimateUsd };
};

/** Per-filter savings of some groups, most saved first. */
export const byFilterOf = (
  groups: readonly StatGroup[],
  prices: ReadonlyMap<string, EstimateCachePrices>,
): TokenSaverFilterSavings[] => {
  const byFilter = new Map<string, StatGroup[]>();
  for (const g of groups) {
    byFilter.set(g.filter, [...(byFilter.get(g.filter) ?? []), g]);
  }
  return [...byFilter]
    .map(([filter, of]) => ({
      filter,
      ...savedOf(of, prices),
      commands: sum(of, 'commands'),
      bypassed: sum(of, 'bypassed'),
      passedThrough: sum(of, 'passedThrough'),
    }))
    .sort(
      (a, b) =>
        b.estimateTokens - a.estimateTokens || a.filter.localeCompare(b.filter),
    );
};

export const sum = (
  groups: readonly StatGroup[],
  key: 'commands' | 'rawBytes' | 'keptBytes' | 'bypassed' | 'passedThrough',
): number => groups.reduce((total, g) => total + g[key], 0);

/** What the board's card view needs of the token saver (#445 D8, D13). */
export interface TokenSaverCardFacts {
  /** Each run's estimate; absent when nothing of the run was filtered. */
  tokenSaved: ReadonlyMap<string, TokenSavedView>;
  /** Each run's per-filter breakdown, most saved first; absent is none. */
  tokenSaverFilters: ReadonlyMap<string, TokenSaverFilterSavings[]>;
  /** Runs whose finish the artifact guard accepted incomplete. */
  artifactIncomplete: ReadonlySet<string>;
  /** #748 D1: each tracked session's estimate; absent when nothing was filtered. */
  tokenSavedBySession: ReadonlyMap<string, TokenSavedView>;
  /** #748: each tracked session's per-filter breakdown, most saved first. */
  tokenSaverFiltersBySession: ReadonlyMap<string, TokenSaverFilterSavings[]>;
}

/**
 * The board's token-saver facts of some round runs and the sessions tracked
 * to cards (#748 D1: a terminal card has no round, its session's rows are its
 * figure).
 */
export const tokenSaverFactsOf = async (
  prisma: PrismaService,
  runIds: string[],
  trackedSessionIds: string[] = [],
): Promise<TokenSaverCardFacts> => {
  const [runGroups, sessionGroups, incomplete] = await Promise.all([
    statGroupsOfRuns(prisma, runIds),
    statGroupsOfSessions(prisma, trackedSessionIds),
    runIds.length === 0
      ? []
      : prisma.run.findMany({
          where: { id: { in: runIds }, artifactIncomplete: true },
          select: { id: true },
        }),
  ]);
  const groups = [...runGroups, ...sessionGroups];
  const prices = await cachePricesOfGroups(prisma, groups);
  const tokenSaved = new Map<string, TokenSavedView>();
  const tokenSaverFilters = new Map<string, TokenSaverFilterSavings[]>();
  const tokenSavedBySession = new Map<string, TokenSavedView>();
  const tokenSaverFiltersBySession = new Map<
    string,
    TokenSaverFilterSavings[]
  >();
  for (const runId of new Set(runGroups.map((g) => g.runId))) {
    if (runId === null) continue;
    const of = runGroups.filter((g) => g.runId === runId);
    tokenSaved.set(runId, savedOf(of, prices));
    tokenSaverFilters.set(runId, byFilterOf(of, prices));
  }
  for (const sessionId of new Set(sessionGroups.map((g) => g.sessionId))) {
    if (sessionId === null) continue;
    const of = sessionGroups.filter((g) => g.sessionId === sessionId);
    tokenSavedBySession.set(sessionId, savedOf(of, prices));
    tokenSaverFiltersBySession.set(sessionId, byFilterOf(of, prices));
  }
  return {
    tokenSaved,
    tokenSaverFilters,
    artifactIncomplete: new Set(incomplete.map((r) => r.id)),
    tokenSavedBySession,
    tokenSaverFiltersBySession,
  };
};
