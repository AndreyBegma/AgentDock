import { type RestartEstimate, restartEstimateSchema } from '@agentdock/shared';
import type { TokenBuckets } from '@agentdock/shared/protocol';
import type { BoardCardRound } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service';
import { sessionModelByRun } from '../history/run-usage';
import { CostService, type Pricer } from '../prices/cost.service';
import { COST_SCALE } from '../prices/pricing';

const NO_TOKENS: TokenBuckets = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  reasoning: 0,
};

/**
 * #449 D9: what a `fresh` start saved on its first turn, in USD at the
 * current price version (ADR-0009) for the model the round's session ran on
 * (`sessionModelByRun`; the run's own `model` may be an alias) — the resume
 * estimate (history as a cache read while warm, as uncached input once cold)
 * less the fresh estimate (the seed as uncached input). A decimal string
 * like `costUsd`; `null` when the model is unpriced or nothing was saved.
 */
export const restartSavedUsd = (
  pricer: Pricer,
  model: string,
  estimate: RestartEstimate,
): string | null => {
  const resume = pricer.price(model, {
    ...NO_TOKENS,
    ...(estimate.cacheWarm
      ? { cacheRead: estimate.resumeTokens }
      : { input: estimate.resumeTokens }),
  }).costUsd;
  const fresh = pricer.price(model, {
    ...NO_TOKENS,
    input: estimate.freshTokens,
  }).costUsd;
  if (resume === null || fresh === null) return null;
  const saved = resume.minus(fresh);
  return saved.isPositive() && !saved.isZero()
    ? saved.toFixed(COST_SCALE)
    : null;
};

/**
 * #449 D9: the saving of each `fresh` round among `rounds`, by round id —
 * `CardFacts.restartSavings`. Other rounds, and rounds whose run has no
 * priced request yet or whose estimate does not parse, are absent.
 */
export const restartSavingsFor = async (
  prisma: PrismaService,
  rounds: readonly Pick<
    BoardCardRound,
    'id' | 'runId' | 'restartMode' | 'restartEstimate'
  >[],
): Promise<Map<string, string>> => {
  const saved = new Map<string, string>();
  const fresh = rounds.flatMap((round) => {
    if (round.restartMode !== 'fresh') return [];
    const estimate = restartEstimateSchema.safeParse(round.restartEstimate);
    return estimate.success ? [{ round, estimate: estimate.data }] : [];
  });
  if (fresh.length === 0) return saved;
  const [models, pricer] = await Promise.all([
    sessionModelByRun(
      prisma,
      fresh.map((f) => f.round.runId),
    ),
    new CostService(prisma).current(),
  ]);
  for (const { round, estimate } of fresh) {
    const model = models.get(round.runId);
    if (!model) continue;
    const usd = restartSavedUsd(pricer, model, estimate);
    if (usd !== null) saved.set(round.id, usd);
  }
  return saved;
};
