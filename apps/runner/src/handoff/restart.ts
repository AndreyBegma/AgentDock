import type { CardRestartMode, RestartEstimate } from '@agentdock/shared';
import type { TranscriptStats } from './transcript';

/**
 * #449 D3: how the next card round starts, by the estimated cost of its first
 * turn. Resume re-reads the history: priced as a cache read while the cache
 * is warm, as uncached input once it is cold. Fresh sends the seed (note,
 * diff summary, checklist, card prompt) as uncached input. Both raw token
 * counts are recorded; the comparison prices them.
 */

/** Claude's default prompt-cache lifetime. */
export const CACHE_TTL_5M_MS = 5 * 60_000;
/** The lifetime of 1-hour cache writes. */
export const CACHE_TTL_1H_MS = 60 * 60_000;

/** A cache read costs this share of uncached input. */
export const CACHE_READ_PRICE_RATIO = 0.1;

/** Spec open question: 5 minutes unless the session wrote 1-hour cache. */
export const cacheTtlMs = (stats: TranscriptStats): number =>
  stats.cache1h ? CACHE_TTL_1H_MS : CACHE_TTL_5M_MS;

export const cacheWarm = (stats: TranscriptStats, now: number): boolean =>
  stats.lastTurnAt !== null && now - stats.lastTurnAt < cacheTtlMs(stats);

export interface RestartDecision {
  mode: Exclude<CardRestartMode, 'first'>;
  estimate: RestartEstimate;
}

/**
 * The cheaper start. `freshTokens` is null when a fresh start is not possible
 * (no valid note, no saved card prompt, the seed does not fit): then resume,
 * with the fresh estimate recorded as 0 tokens — it was not an option.
 */
export const decideRestart = (
  stats: TranscriptStats,
  freshTokens: number | null,
  now: number,
): RestartDecision => {
  const warm = cacheWarm(stats, now);
  const estimate: RestartEstimate = {
    resumeTokens: stats.historyTokens,
    freshTokens: freshTokens ?? 0,
    cacheWarm: warm,
  };
  if (freshTokens === null) return { mode: 'resume', estimate };
  const resumeCost = stats.historyTokens * (warm ? CACHE_READ_PRICE_RATIO : 1);
  return { mode: freshTokens < resumeCost ? 'fresh' : 'resume', estimate };
};
