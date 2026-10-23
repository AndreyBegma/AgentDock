/**
 * D12: the filter's estimate is bytes / 4 — labelled "≈" wherever it shows.
 * The fact (cost per run before and after) comes from usage, not from here.
 */
export const TOKEN_SAVER_BYTES_PER_TOKEN = 4;

/** Tokens a filtered command saved, by the estimate; never negative. */
export const estimateTokensSaved = (
  rawBytes: number,
  keptBytes: number,
): number =>
  Math.max(0, Math.round((rawBytes - keptBytes) / TOKEN_SAVER_BYTES_PER_TOKEN));

/**
 * ADR-0074 §5 (amends #445 D12): the cache prices of the session model — USD
 * per token, as `TierPrices` stores them (ADR-0009; the API owns the price
 * table). `write` is the 5-minute or the 1-hour write price, whichever TTL
 * the run wrote with.
 */
export interface EstimateCachePrices {
  write: string;
  read: string;
}

const perToken = (usd: string): number => {
  const price = Number(usd);
  return Number.isFinite(price) && price > 0 ? price : 0;
};

/**
 * #746 D6: tokens a filter kept out of the context would have been written to
 * the prompt cache once, then read on every turn until the next compaction —
 * `tokens × (write + read × turnsRemaining)`. An unpriceable string prices
 * that part at 0; negative turns count as none.
 */
export const estimateUsdSaved = (
  tokens: number,
  prices: EstimateCachePrices,
  turnsRemaining: number,
): number =>
  tokens *
  (perToken(prices.write) +
    perToken(prices.read) * Math.max(0, turnsRemaining));
