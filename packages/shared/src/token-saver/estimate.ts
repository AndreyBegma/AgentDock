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
 * Prices an estimate at the session model's `input` price — USD per token, as
 * `TierPrices` stores it (ADR-0009; the API owns the price table). An
 * unpriceable string prices at 0.
 */
export const estimateUsdSaved = (
  tokens: number,
  inputUsdPerToken: string,
): number => {
  const price = Number(inputUsdPerToken);
  return Number.isFinite(price) && price > 0 ? tokens * price : 0;
};
