import type {
  TokenSavedView,
  TokenSaverFilterSavings,
  TokenSaverRunKind,
  TokenSaverUnfilteredProgram,
} from '@agentdock/shared';
import {
  estimateUsdSaved,
  FILTER_ID_NONE,
  FILTER_ID_NONE_COMPOUND,
  FILTER_ID_NONE_MODE,
  FILTER_ID_NONE_UNCOVERED,
  TOKEN_SAVER_BYTES_PER_TOKEN,
  TOKEN_SAVER_UNFILTERED_PROGRAMS_MAX,
} from '@agentdock/shared';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service';
import { sessionModelByRun } from '../history/run-usage';
import { toModelPrice } from '../prices/cost.service';
import { compilePrices, matchModel } from '../prices/pricing';

/**
 * One group of `token_saver_stats` rows. `tokens` is the sum of each row's
 * estimate (shared `estimateTokensSaved`: (raw − kept) / 4, rounded), so a
 * group's total is the sum of its commands' estimates.
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
}

const STAT_GROUP_COLUMNS = Prisma.sql`
  s."runId", s."runKind"::text AS "runKind", s.filter,
  to_char(s."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
  COUNT(*)::int AS commands,
  COALESCE(SUM(s."rawBytes"), 0)::bigint AS "rawBytes",
  COALESCE(SUM(s."keptBytes"), 0)::bigint AS "keptBytes",
  (COUNT(*) FILTER (WHERE s.bypassed))::int AS bypassed,
  (COUNT(*) FILTER (WHERE s."passedThrough"))::int AS "passedThrough",
  COALESCE(SUM(GREATEST(0, ROUND((s."rawBytes" - s."keptBytes")::numeric / ${TOKEN_SAVER_BYTES_PER_TOKEN}))), 0)::bigint AS tokens`;

const toGroup = (row: StatGroupRow): StatGroup => ({
  ...row,
  rawBytes: Number(row.rawBytes),
  keptBytes: Number(row.keptBytes),
  tokens: Number(row.tokens),
});

/** The stats of some runs, grouped by run, filter and day. */
export const statGroupsOfRuns = async (
  prisma: PrismaService,
  runIds: string[],
): Promise<StatGroup[]> => {
  if (runIds.length === 0) return [];
  const rows = await prisma.$queryRaw<StatGroupRow[]>`
    SELECT ${STAT_GROUP_COLUMNS}
    FROM token_saver_stats s
    WHERE s."runId" IN (${Prisma.join(runIds)})
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
    SELECT ${STAT_GROUP_COLUMNS}
    FROM token_saver_stats s
    WHERE s."projectId" = ${projectId}
      AND s."createdAt" >= ${from} AND s."createdAt" < ${to}
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
 * ADR-0009: the `input` price (USD per token) of each run's session model,
 * from the default tier of the newest price version. A run without requests
 * falls back to `runs.model`; an unpriced one is absent (prices at 0).
 */
export const inputPricesOfRuns = async (
  prisma: PrismaService,
  runIds: string[],
): Promise<Map<string, string>> => {
  if (runIds.length === 0) return new Map();
  const [sessionModels, runs, head] = await Promise.all([
    sessionModelByRun(prisma, runIds),
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
  const out = new Map<string, string>();
  for (const run of runs) {
    const model = sessionModels.get(run.id) ?? run.model;
    if (model === null) continue;
    const input = matchModel(prices, model)?.tiers.find((t) => t.isDefault)
      ?.prices.input;
    if (input !== undefined) out.set(run.id, input);
  }
  return out;
};

/** The estimate of some groups, each priced at its run's input price. */
export const savedOf = (
  groups: readonly StatGroup[],
  prices: ReadonlyMap<string, string>,
): TokenSavedView => {
  let estimateTokens = 0;
  let estimateUsd = 0;
  for (const g of groups) {
    estimateTokens += g.tokens;
    const price = g.runId === null ? undefined : prices.get(g.runId);
    estimateUsd += price === undefined ? 0 : estimateUsdSaved(g.tokens, price);
  }
  return { estimateTokens, estimateUsd };
};

/** Per-filter savings of some groups, most saved first. */
export const byFilterOf = (
  groups: readonly StatGroup[],
  prices: ReadonlyMap<string, string>,
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
  const prices = await inputPricesOfRuns(prisma, filtered);
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
