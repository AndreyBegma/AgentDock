import {
  GITHUB_HEALTH_INTERVAL_MS,
  GITHUB_POLL_DEBOUNCE_MS,
} from '@agentdock/shared';

/** How the GitHub App module reaches GitHub and paces its loops; tests override it. */
export interface GitHubAppOptions {
  /**
   * `PUBLIC_URL` — the HTTPS base GitHub can reach (D14). Null: the manifest's
   * hook is inactive and every project stays `unhealthy`.
   */
  publicUrl: string | null;
  /** `APP_URL` (else `WEB_URL`) — the web app the browser comes back to (D1). */
  appUrl: string;
  /** `GITHUB_API_BASE` — tests point it at a fake server. */
  apiBase: string;
  /** D8: the poll debounce window. */
  debounceMs: number;
  /** D11: health recompute interval. */
  healthIntervalMs: number;
  /** Start the health loop at bootstrap. Never under `APP_ENV=test`: suites drive it. */
  autoStart: boolean;
  /** Per-request timeout towards GitHub. */
  requestTimeoutMs: number;
  /** The HTTP client; tests may inject one. */
  fetch: typeof fetch;
}

export const GITHUB_APP_OPTIONS = Symbol('GITHUB_APP_OPTIONS');

export const DEFAULT_GITHUB_API_BASE = 'https://api.github.com';

const url = (raw: string | undefined): string | null =>
  raw?.trim().replace(/\/+$/, '') || null;

export const githubAppOptionsFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): GitHubAppOptions => ({
  publicUrl: url(env.PUBLIC_URL),
  appUrl: url(env.APP_URL) ?? url(env.WEB_URL) ?? 'http://localhost:3517',
  apiBase: url(env.GITHUB_API_BASE) ?? DEFAULT_GITHUB_API_BASE,
  debounceMs: GITHUB_POLL_DEBOUNCE_MS,
  healthIntervalMs: GITHUB_HEALTH_INTERVAL_MS,
  autoStart: env.APP_ENV !== 'test',
  requestTimeoutMs: 10_000,
  fetch: (input, init) => fetch(input, init),
});
