import {
  TOKEN_SAVER_SESSION_KINDS,
  type TokenSaverCostPerRound,
  type TokenSaverSessionKind,
} from '@nautelle/shared';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service';
import {
  isoWeekOf,
  ROUND_COST_COLUMNS,
  type RoundCostGroup,
  type RoundCostRow,
  roundCostsByKind,
  toRoundCostGroup,
} from '../history/run-usage';

/**
 * #663 D5: the assistant chat's rounds — each reply of a conversation of the
 * project created in `[from, to)`, with the `llm_calls` it made. Its turns are
 * those calls; every call is priced, so every round is.
 */
const assistantRoundCosts = async (
  prisma: PrismaService,
  projectId: string,
  from: Date,
  to: Date,
): Promise<RoundCostGroup[]> => {
  const rows = await prisma.$queryRaw<RoundCostRow[]>`
    WITH rounds AS (
      SELECT
        'assistant' AS kind,
        ${isoWeekOf(Prisma.sql`m."createdAt"`)} AS week,
        SUM(lc."costUsd") AS cost,
        SUM(lc.input) AS input,
        SUM(lc."cacheRead") AS "cacheRead",
        SUM(lc."cacheWrite5m" + lc."cacheWrite1h") AS "cacheWrite",
        MAX(lc.input + lc."cacheRead" + lc."cacheWrite5m" + lc."cacheWrite1h") AS peak,
        COUNT(lc.id) AS turns
      FROM assistant_messages m
      JOIN assistant_conversations ac ON ac.id = m."conversationId"
      JOIN llm_calls lc ON lc.id = ANY(m."llmCallIds")
      WHERE ac."projectId" = ${projectId}
        AND m.role = 'assistant'
        AND m."createdAt" >= ${from} AND m."createdAt" < ${to}
      GROUP BY m.id, m."createdAt"
    )
    SELECT ${ROUND_COST_COLUMNS}
    FROM rounds
    GROUP BY kind, week`;
  return rows.map(toRoundCostGroup);
};

const isSessionKind = (kind: string): kind is TokenSaverSessionKind =>
  (TOKEN_SAVER_SESSION_KINDS as readonly string[]).includes(kind);

/**
 * #663 D5: cost per round of a project in `[from, to)` by session kind and
 * ISO week, in `TOKEN_SAVER_SESSION_KINDS` order, oldest week first. Kinds
 * without a measurable round (`TOKEN_SAVER_UNMEASURED_KINDS`) are absent.
 */
export const costPerRoundOfProject = async (
  prisma: PrismaService,
  projectId: string,
  from: Date,
  to: Date,
): Promise<TokenSaverCostPerRound[]> => {
  const [runs, assistant] = await Promise.all([
    roundCostsByKind(prisma, projectId, from, to),
    assistantRoundCosts(prisma, projectId, from, to),
  ]);
  const order = (kind: TokenSaverSessionKind) =>
    TOKEN_SAVER_SESSION_KINDS.indexOf(kind);
  return [...runs, ...assistant]
    .flatMap((g): TokenSaverCostPerRound[] => {
      if (!isSessionKind(g.kind)) return [];
      const tokens = g.input + g.cacheRead + g.cacheWrite;
      return [
        {
          sessionKind: g.kind,
          week: g.week,
          rounds: g.rounds,
          pricedRounds: g.pricedRounds,
          medianUsd: g.medianUsd,
          p90Usd: g.p90Usd,
          cacheReadShare: tokens === 0 ? 0 : g.cacheRead / tokens,
          medianPeakContext: g.medianPeakContext,
          medianTurns: g.medianTurns,
        },
      ];
    })
    .sort(
      (a, b) =>
        order(a.sessionKind) - order(b.sessionKind) ||
        a.week.localeCompare(b.week),
    );
};
