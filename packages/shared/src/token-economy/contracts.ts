import { z } from 'zod';
import type { TokenEconomyInterval } from './stats';
import {
  type TechniqueArm,
  type TechniqueMode,
  techniqueModeSchema,
} from './techniques';

/**
 * #746 D3, D4: the four signals that say the result did not suffer. Each is
 * per settled card:
 * - `greenFirstPush` (a): the card had no `ci_fix` round — a rate;
 * - `rounds` (b): its rounds — a mean, lower is better;
 * - `noReviewReturns` (c): merged with no `feedback` round after the first
 *   `run` round — a rate;
 * - `noRetries` (d): its runs' retries sum to 0 — a rate.
 */
export const TOKEN_ECONOMY_SIGNALS = [
  'greenFirstPush',
  'rounds',
  'noReviewReturns',
  'noRetries',
] as const;
export type TokenEconomySignal = (typeof TOKEN_ECONOMY_SIGNALS)[number];

/** Whether a higher value of the signal is the better one. */
export const SIGNAL_HIGHER_IS_BETTER: Record<TokenEconomySignal, boolean> = {
  greenFirstPush: true,
  rounds: false,
  noReviewReturns: true,
  noRetries: true,
};

/** One arm of one technique in `GET /projects/:id/token-economy/report`. */
export interface TokenEconomyArmReport {
  arm: TechniqueArm;
  /** Settled cards: PR merged or closed, or the card completed. */
  settledCards: number;
  mergedCards: number;
  /** Of the arm's B cards, those assigned while the mode was `on`. */
  forcedCards: number;
  /**
   * #746 D1: Σ billed cost of the settled cards ÷ the merged cards, USD,
   * with a bootstrap interval over cards. `point` is null with no merged card.
   */
  costPerSuccessUsd: TokenEconomyInterval;
  /** The median billed cost of a merged card, USD; null with none. */
  medianMergedCostUsd: number | null;
  signals: Record<TokenEconomySignal, TokenEconomyInterval>;
}

export interface TokenEconomyTechniqueReport {
  technique: string;
  label: string;
  mode: TechniqueMode;
  a: TokenEconomyArmReport;
  b: TokenEconomyArmReport;
  /** Both arms have at least `minCardsPerArm` settled cards. */
  enoughData: boolean;
  /** Signals whose B interval lies wholly on the worse side of A's point. */
  worsens: TokenEconomySignal[];
}

/** `GET /projects/:projectId/token-economy/report?from&to`. */
export interface TokenEconomyReport {
  from: string;
  to: string;
  bSharePercent: number;
  minCardsPerArm: number;
  techniques: TokenEconomyTechniqueReport[];
}

/** `PUT /projects/:projectId/token-economy/settings`. */
export const tokenEconomySettingsBodySchema = z.strictObject({
  bSharePercent: z.number().int().min(0).max(100),
});
export type TokenEconomySettingsBody = z.infer<
  typeof tokenEconomySettingsBodySchema
>;

export interface TokenEconomySettingsView {
  bSharePercent: number;
  /** `null` when the project has no row (the default applies). */
  updatedAt: string | null;
}

/** `PUT /projects/:projectId/token-economy/techniques/:technique`. */
export const tokenEconomyTechniqueBodySchema = z.strictObject({
  mode: techniqueModeSchema,
});
export type TokenEconomyTechniqueBody = z.infer<
  typeof tokenEconomyTechniqueBodySchema
>;

export interface TokenEconomyTechniqueView {
  technique: string;
  mode: TechniqueMode;
  /** `null` when the project has no row (the registry's default applies). */
  changedAt: string | null;
}
