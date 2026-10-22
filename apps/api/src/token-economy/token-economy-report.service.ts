import {
  bootstrapCi,
  median,
  SIGNAL_HIGHER_IS_BETTER,
  type TechniqueArm,
  TOKEN_ECONOMY_MIN_CARDS_PER_ARM,
  TOKEN_ECONOMY_SIGNALS,
  type TokenEconomyArmReport,
  type TokenEconomyReport,
  type TokenEconomyTechniqueReport,
  whollyWorse,
  wilson,
} from '@nautelle/shared';
import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { RunUsageFactsService } from './run-usage-facts.service';
import { TokenEconomyService } from './token-economy.service';

/** One card with an arm, joined with its quality signals (D4). */
export interface ArmCard {
  technique: string;
  arm: TechniqueArm;
  mode: string;
  settled: boolean;
  merged: boolean;
  /** Billed cost of the card's runs, subagents included (D1). */
  cost: number;
  greenFirstPush: boolean;
  rounds: number;
  noReviewReturns: boolean;
  retries: number;
}

interface ArmCardRow extends Omit<ArmCard, 'cost'> {
  cost: string | null;
}

const costPerSuccess = (cards: readonly ArmCard[]): number | null => {
  const merged = cards.filter((c) => c.merged).length;
  return merged === 0 ? null : cards.reduce((s, c) => s + c.cost, 0) / merged;
};

const meanRounds = (cards: readonly ArmCard[]): number | null =>
  cards.length === 0
    ? null
    : cards.reduce((s, c) => s + c.rounds, 0) / cards.length;

const rate = (cards: readonly ArmCard[], ok: (c: ArmCard) => boolean) =>
  wilson(cards.filter(ok).length, cards.length);

/** D1, D3, D5: one arm of one technique, over its settled cards. */
export const armReport = (
  arm: TechniqueArm,
  cards: readonly ArmCard[],
): TokenEconomyArmReport => {
  const settled = cards.filter((c) => c.settled);
  const merged = settled.filter((c) => c.merged);
  return {
    arm,
    settledCards: settled.length,
    mergedCards: merged.length,
    forcedCards: cards.filter((c) => c.arm === 'b' && c.mode === 'on').length,
    costPerSuccessUsd: bootstrapCi(settled, costPerSuccess),
    medianMergedCostUsd: median(merged.map((c) => c.cost)),
    signals: {
      greenFirstPush: rate(settled, (c) => c.greenFirstPush),
      rounds: bootstrapCi(settled, meanRounds),
      noReviewReturns: rate(settled, (c) => c.noReviewReturns),
      noRetries: rate(settled, (c) => c.retries === 0),
    },
  };
};

/** `enoughData` and `worsens` of a technique from its two arms. */
export const verdictOf = (
  a: TokenEconomyArmReport,
  b: TokenEconomyArmReport,
  minCardsPerArm = TOKEN_ECONOMY_MIN_CARDS_PER_ARM,
): Pick<TokenEconomyTechniqueReport, 'enoughData' | 'worsens'> => ({
  enoughData:
    a.settledCards >= minCardsPerArm && b.settledCards >= minCardsPerArm,
  worsens: TOKEN_ECONOMY_SIGNALS.filter((s) =>
    whollyWorse(a.signals[s], b.signals[s], SIGNAL_HIGHER_IS_BETTER[s]),
  ),
});

const DAY_MS = 86_400_000;
/** The longest range a report may span. */
export const TOKEN_ECONOMY_REPORT_MAX_DAYS = 366;

/**
 * `GET /projects/:projectId/token-economy/report` (#746 D1–D5): per
 * registered technique and arm, the cards whose arm was drawn in
 * `[from, to)`. Only cards of the project are read.
 */
@Injectable()
export class TokenEconomyReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly economy: TokenEconomyService,
    private readonly facts: RunUsageFactsService,
  ) {}

  async report(
    projectId: string,
    fromIso: string,
    toIso: string,
  ): Promise<TokenEconomyReport> {
    const from = new Date(fromIso);
    const to = new Date(toIso);
    if (from >= to) {
      throw new BadRequestException('from must be before to');
    }
    if (
      to.getTime() - from.getTime() >
      TOKEN_ECONOMY_REPORT_MAX_DAYS * DAY_MS
    ) {
      throw new BadRequestException(
        `The range may span at most ${TOKEN_ECONOMY_REPORT_MAX_DAYS} days`,
      );
    }
    const keys = this.economy.techniques.map((t) => t.key);
    const [settings, modes, cards] = await Promise.all([
      this.economy.settings(projectId),
      this.economy.modes(projectId),
      keys.length === 0
        ? Promise.resolve([])
        : this.armCards(projectId, keys, from, to),
    ]);
    const techniques = this.economy.techniques.map((t) => {
      const of = cards.filter((c) => c.technique === t.key);
      const a = armReport(
        'a',
        of.filter((c) => c.arm === 'a'),
      );
      const b = armReport(
        'b',
        of.filter((c) => c.arm === 'b'),
      );
      return {
        technique: t.key,
        label: t.label,
        mode: modes.find((m) => m.technique === t.key)?.mode ?? t.defaultMode,
        a,
        b,
        ...verdictOf(a, b),
      };
    });
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      bSharePercent: settings.bSharePercent,
      minCardsPerArm: TOKEN_ECONOMY_MIN_CARDS_PER_ARM,
      techniques,
    };
  }

  /**
   * D4: the project's cards with an arm drawn in `[from, to)`, each with its
   * signals and billed cost. Settled: PR merged or closed, or the card
   * completed. The facts of their ended runs are built first when missing.
   * D11: a card counts only when one of its runs launched the technique
   * (`runs.techniques` holds its key) — an arm drawn for a runner that never
   * received the flags says nothing about the technique.
   */
  private async armCards(
    projectId: string,
    keys: string[],
    from: Date,
    to: Date,
  ): Promise<ArmCard[]> {
    const runs = await this.prisma.boardCardRound.findMany({
      where: {
        card: {
          projectId,
          techniqueArms: {
            some: {
              technique: { in: keys },
              assignedAt: { gte: from, lt: to },
            },
          },
        },
      },
      select: { runId: true },
    });
    await this.facts.ensureRuns(runs.map((r) => r.runId));
    const rows = await this.prisma.$queryRaw<ArmCardRow[]>`
      SELECT a.technique, a.arm::text AS arm, a.mode::text AS mode,
        (c."prState" IN ('merged', 'closed') OR c."completedAt" IS NOT NULL) AS settled,
        COALESCE(c."prState" = 'merged', false) AS merged,
        (SELECT SUM(f."costUsd") FROM board_card_rounds r
          JOIN run_usage_facts f ON f."runId" = r."runId"
          WHERE r."cardId" = c.id)::text AS cost,
        NOT EXISTS (SELECT 1 FROM board_card_rounds r
          WHERE r."cardId" = c.id AND r.trigger = 'ci_fix') AS "greenFirstPush",
        (SELECT COUNT(*) FROM board_card_rounds r WHERE r."cardId" = c.id)::int AS rounds,
        (COALESCE(c."prState" = 'merged', false) AND NOT EXISTS (
          SELECT 1 FROM board_card_rounds r
          WHERE r."cardId" = c.id AND r.trigger = 'feedback'
            AND r.round > (SELECT MIN(r2.round) FROM board_card_rounds r2
              WHERE r2."cardId" = c.id AND r2.trigger = 'run')
        )) AS "noReviewReturns",
        (SELECT COALESCE(SUM(ru.retries), 0) FROM board_card_rounds r
          JOIN runs ru ON ru.id = r."runId"
          WHERE r."cardId" = c.id)::int AS retries
      FROM card_technique_arms a
      JOIN board_cards c ON c.id = a."cardId"
      WHERE c."projectId" = ${projectId}
        AND a.technique IN (${Prisma.join(keys)})
        AND a."assignedAt" >= ${from} AND a."assignedAt" < ${to}
        AND EXISTS (SELECT 1 FROM board_card_rounds r
          JOIN runs ru ON ru.id = r."runId"
          WHERE r."cardId" = c.id AND jsonb_exists(ru.techniques, a.technique))`;
    return rows.map((row) => ({
      ...row,
      cost: row.cost === null ? 0 : Number(row.cost),
    }));
  }
}
