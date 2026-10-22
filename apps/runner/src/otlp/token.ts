import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * L-30: the header every exporter the runner configures sends, carrying the
 * receiver's token. A custom name keeps the value free of spaces, which
 * `OTEL_EXPORTER_OTLP_HEADERS` would need percent-encoded.
 */
export const OTLP_TOKEN_HEADER = 'x-nautelle-otlp-token';

/** Where the receiver listens and the token it asks for. */
export interface OtlpEndpoint {
  port: number;
  token: string;
}

/** `~/.local/state/nautelle/otlp.key`, beside the session-token secret. */
export const otlpTokenPath = (stateDir: string): string =>
  join(stateDir, 'otlp.key');

const TOKEN = /^[0-9a-f]{64}$/;

/**
 * The receiver's token, created 0600 on first use. It is kept on disk, not
 * made per boot: `setup claude` writes it into `settings.json`, which has to
 * keep working after the daemon restarts. Replacing the file revokes it.
 */
export const loadOtlpToken = (path: string): string => {
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (TOKEN.test(existing)) return existing;
  } catch {
    // Created below.
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return token;
};

/** The `OTEL_EXPORTER_OTLP_HEADERS` value that carries `token`. */
export const otlpHeaders = (token: string): string =>
  `${OTLP_TOKEN_HEADER}=${token}`;

/** Whether `value` is a headers value this runner could have written. */
export const isOtlpHeaders = (value: unknown): boolean =>
  typeof value === 'string' &&
  value.startsWith(`${OTLP_TOKEN_HEADER}=`) &&
  TOKEN.test(value.slice(OTLP_TOKEN_HEADER.length + 1));

/** Constant-time comparison of a presented token with the expected one. */
export const tokenMatches = (given: string | null, token: string): boolean => {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};
