/** How the Telegram module reaches the Bot API and paces its loops; tests override it. */
export interface TelegramOptions {
  /** `TELEGRAM_API_BASE` — tests point it at a fake server. */
  apiBase: string;
  /** `TELEGRAM_POLL_TIMEOUT_S` — the `getUpdates` long-poll timeout (D7). */
  pollTimeoutS: number;
  /** `APP_URL` — the web app, prefixed to message links (D10); null: no link. */
  appUrl: string | null;
  /** Start the poller at bootstrap. Never under `APP_ENV=test`: suites drive it. */
  autoStart: boolean;
  /** How often the leader sends what the delivery ledger hands out. */
  deliveryIntervalMs: number;
  /** Pause between polls while the bot is unconfigured or after an error. */
  idleMs: number;
  /** The HTTP client; tests may inject one. */
  fetch: typeof fetch;
}

export const TELEGRAM_OPTIONS = Symbol('TELEGRAM_OPTIONS');

export const DEFAULT_TELEGRAM_API_BASE = 'https://api.telegram.org';
const DEFAULT_POLL_TIMEOUT_S = 30;
const MAX_POLL_TIMEOUT_S = 50;

const pollTimeout = (raw: string | undefined): number => {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= MAX_POLL_TIMEOUT_S
    ? value
    : DEFAULT_POLL_TIMEOUT_S;
};

export const telegramOptionsFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): TelegramOptions => ({
  apiBase: env.TELEGRAM_API_BASE?.trim() || DEFAULT_TELEGRAM_API_BASE,
  pollTimeoutS: pollTimeout(env.TELEGRAM_POLL_TIMEOUT_S),
  appUrl: env.APP_URL?.trim().replace(/\/+$/, '') || null,
  autoStart: env.APP_ENV !== 'test',
  deliveryIntervalMs: 2_000,
  idleMs: 5_000,
  fetch: (input, init) => fetch(input, init),
});
