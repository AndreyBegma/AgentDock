/** What a redacted secret is replaced with. */
export const REDACTED_SECRET = '[redacted]';

/**
 * Shapes of provider keys and bearer tokens, redacted even when the exact key
 * is not at hand (ADR-0057 §3): `sk-…` (Anthropic, OpenAI, OpenRouter),
 * `xai-…`, and an `Authorization` / `x-api-key` value.
 */
const KEY_SHAPES = [
  /\b(?:sk|xai)-[A-Za-z0-9_-]{8,}/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\b(x-api-key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
];

/**
 * `text` with every given secret, and anything shaped like a key, replaced.
 * Used on every provider error message before it is thrown or logged.
 */
export const redactSecrets = (
  text: string,
  secrets: readonly string[] = [],
): string => {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join(REDACTED_SECRET);
  }
  for (const shape of KEY_SHAPES) {
    out = out.replace(shape, (_match, prefix?: string) =>
      typeof prefix === 'string'
        ? `${prefix}${REDACTED_SECRET}`
        : REDACTED_SECRET,
    );
  }
  return out;
};
