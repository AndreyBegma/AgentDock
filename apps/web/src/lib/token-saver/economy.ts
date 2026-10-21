import {
  type TechniqueMode,
  TOKEN_ECONOMY_SIGNALS,
  type TokenEconomyInterval,
  type TokenEconomySignal,
  type TokenEconomyTechniqueReport,
} from '@nautelle/shared';
import { formatCost } from '../format';

/** #746 D3: the four signals that say the result did not suffer. */
export const SIGNAL_LABEL: Record<TokenEconomySignal, string> = {
  greenFirstPush: 'Green on the first push',
  rounds: 'Rounds per card',
  noReviewReturns: 'Merged without review returns',
  noRetries: 'No retries',
};

/** What each signal counts, for a row's title. */
export const SIGNAL_HINT: Record<TokenEconomySignal, string> = {
  greenFirstPush: 'Settled cards that never needed a CI-fix round.',
  rounds: 'The mean number of rounds a settled card took; lower is better.',
  noReviewReturns:
    'Settled cards merged with no feedback round after the first run.',
  noRetries:
    'Settled cards whose agents never re-ran a command raw or re-read a refused file.',
};

/** #746 D9: a technique's mode as a person reads it. */
export const MODE_LABEL: Record<TechniqueMode, string> = {
  off: 'Off',
  ab: 'A/B test',
  on: 'On for every card',
};

/** A figure and its 95 % interval, as the report draws them. */
export interface ShownInterval {
  point: string;
  /** `low–high`; null when there is no interval. */
  range: string | null;
}

const NONE: ShownInterval = { point: '—', range: null };

const percent = (rate: number) => `${Math.round(rate * 100)}`;

const show = (
  i: TokenEconomyInterval,
  point: (v: number) => string,
  range: (low: number, high: number) => string,
): ShownInterval =>
  i.point === null
    ? NONE
    : {
        point: point(i.point),
        range: i.low === null || i.high === null ? null : range(i.low, i.high),
      };

/** $/successful card: `$1.20`, `$0.90–$1.60`. */
export const formatCostInterval = (i: TokenEconomyInterval): ShownInterval =>
  show(
    i,
    (v) => formatCost(v),
    (low, high) => `${formatCost(low)}–${formatCost(high)}`,
  );

/** A signal: a rate as `62%` / `48–74%`, rounds as `3.1` / `2.6–3.7`. */
export const formatSignalInterval = (
  signal: TokenEconomySignal,
  i: TokenEconomyInterval,
): ShownInterval =>
  signal === 'rounds'
    ? show(
        i,
        (v) => v.toFixed(1),
        (low, high) => `${low.toFixed(1)}–${high.toFixed(1)}`,
      )
    : show(
        i,
        (v) => `${percent(v)}%`,
        (low, high) => `${percent(low)}–${percent(high)}%`,
      );

/**
 * The enough-data marker: `Enough data`, or how far each arm is from the
 * threshold — `Collecting · A 12/30 · B 8/30`.
 */
export const dataLabel = (
  t: TokenEconomyTechniqueReport,
  minCardsPerArm: number,
): string =>
  t.enoughData
    ? 'Enough data'
    : `Collecting · A ${t.a.settledCards}/${minCardsPerArm} · B ${t.b.settledCards}/${minCardsPerArm}`;

const listOf = (signals: readonly TokenEconomySignal[]) =>
  signals.map((s) => SIGNAL_LABEL[s].toLowerCase()).join(', ');

/**
 * #746 D3, D5: what Enable for all does, naming the signals to check first —
 * and any arm B already worsens, and too little data, said plainly.
 */
export const enableConsequence = (
  t: TokenEconomyTechniqueReport,
  minCardsPerArm: number,
): string =>
  [
    `Every new card will run ${t.label}. Cards already in arm A keep running without it until they settle.`,
    `It should not cost quality on any of the four signals: ${listOf(TOKEN_ECONOMY_SIGNALS)}.`,
    t.worsens.length > 0 ? `Arm B is worse on ${listOf(t.worsens)}.` : null,
    t.enoughData
      ? null
      : `There is not enough data for a verdict yet: ${t.a.settledCards} settled cards in A and ${t.b.settledCards} in B, of ${minCardsPerArm} each.`,
  ]
    .filter((line): line is string => line !== null)
    .join(' ');

/** #746 D3: what Stop does; arms are sticky, so cards in B keep theirs. */
export const stopConsequence = (t: TokenEconomyTechniqueReport): string =>
  `No new card will run ${t.label}. Cards already in arm B keep running it until they settle.`;

/** The B share field: a whole number 0–100, or null for anything else. */
export const parseBShare = (text: string): number | null => {
  const trimmed = text.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value <= 100 ? value : null;
};
