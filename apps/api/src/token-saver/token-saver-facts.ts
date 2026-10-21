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
  s."runId", s."runKind"::text AS "runKind", s.filter,
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
 */
const withTurns = (picked: Prisma.Sql): Prisma.Sql => Prisma.sql`
  WITH picked AS (${picked}),
  run_requests AS (
    SELECT r.id AS "runId", se.id AS "sessionId", l.ts, l."querySource"
    ${RUN_REQUESTS}
    WHERE r.id IN (SELECT DISTINCT "runId" FROM picked WHERE "runId" IS NOT NULL)
  ),
  bounds AS (
    SELECT "runId", MIN(ts) AS first, MAX(ts) AS last,
      (COUNT(*) FILTER (WHERE "querySource" = 'main'))::int AS main
    FROM run_requests GROUP BY "runId"
  ),
  turns AS (
    SELECT p.id,
      CASE
        WHEN b."runId" IS NULL THEN 0
        WHEN p."createdAt" < b.first OR p."createdAt" > b.last THEN b.main / 2
        ELSE (
          SELECT COUNT(*)::int FROM run_requests q
          WHERE q."runId" = p."runId" AND q."querySource" = 'main'
            AND q.ts > p."createdAt"
            AND q.ts < COALESCE((
              SELECT MIN(c.ts) FROM session_compactions c
              WHERE c.ts > p."createdAt"
                AND c."sessionId" IN (
                  SELECT q2."sessionId" FROM run_requests q2
                  WHERE q2."runId" = p."runId"
                )
            ), 'infinity'::timestamp)
        )
      END AS turns
    FROM picked p
    LEFT JOIN bounds b ON b."runId" = p."runId"
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
    GROUP BY 1, 2, 3, 4`;
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
    GROUP BY 1, 2, 3, 4`;
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
  const [sessionModels, usage, runs, head] = await Promise.all([
    sessionModelByRun(prisma, runIds),
    usageByRun(prisma, runIds),
    prisma.run.findMany({
      where: { id: { in: runIds } },
      select: { id: true, model: true },
    }),
    prisma.priceVersion.findFirst({
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
    }),
  ]);
  const prices = compilePrices((head?.models ?? []).map(toModelPrice));
  const out = new Map<string, EstimateCachePrices>();
  for (const run of runs) {
    const model = sessionModels.get(run.id) ?? run.model;
    if (model === null) continue;
    const tier = matchModel(prices, model)?.tiers.find((t) => t.isDefault);
    if (tier === undefined) continue;
    const p = tier.prices;
    const write5m = p.cacheWrite5m ?? p.input;
    const write1h = p.cacheWrite1h ?? write5m;
    const wrote1h = (usage.get(run.id)?.cacheWrite1h ?? 0) > 0;
    out.set(run.id, {
      write: wrote1h ? write1h : write5m,
      read: p.cacheRead ?? p.input,
    });
  }
  return out;
};

/**
 * The estimate of some groups, each priced at its run's cache prices over
 * its rows' turns remaining (#746 D6).
 */
export const savedOf = (
  groups: readonly StatGroup[],
  prices: ReadonlyMap<string, EstimateCachePrices>,
): TokenSavedView => {
  let estimateTokens = 0;
  let estimateUsd = 0;
  for (const g of groups) {
    estimateTokens += g.tokens;
    const price = g.runId === null ? undefined : prices.get(g.runId);
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
}

/** The board's token-saver facts of some round runs. */
export const tokenSaverFactsOf = async (
  prisma: PrismaService,
  runIds: string[],
): Promise<TokenSaverCardFacts> => {
  if (runIds.length === 0) {
    return {
      tokenSaved: new Map(),
      tokenSaverFilters: new Map(),
      artifactIncomplete: new Set(),
    };
  }
  const [groups, incomplete] = await Promise.all([
    statGroupsOfRuns(prisma, runIds),
    prisma.run.findMany({
      where: { id: { in: runIds }, artifactIncomplete: true },
      select: { id: true },
    }),
  ]);
  const filtered = [
    ...new Set(groups.flatMap((g) => (g.runId === null ? [] : [g.runId]))),
  ];
  const prices = await cachePricesOfRuns(prisma, filtered);
  const tokenSaved = new Map<string, TokenSavedView>();
  const tokenSaverFilters = new Map<string, TokenSaverFilterSavings[]>();
  for (const runId of filtered) {
    const of = groups.filter((g) => g.runId === runId);
    tokenSaved.set(runId, savedOf(of, prices));
    tokenSaverFilters.set(runId, byFilterOf(of, prices));
  }
  return {
    tokenSaved,
    tokenSaverFilters,
    artifactIncomplete: new Set(incomplete.map((r) => r.id)),
  };
};
