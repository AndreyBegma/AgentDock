/** Timings of the live gateway (spec D10, D13); tests override the provider to run fast. */
export interface LiveOptions {
  /** Every connected session is re-resolved this often; a dead one is closed 4401. */
  revalidateMs: number;
  /** The server pings each socket this often. */
  pingIntervalMs: number;
  /** A socket that sent nothing — not even a pong — for this long is dropped. */
  idleTimeoutMs: number;
}

export const LIVE_OPTIONS = Symbol('LIVE_OPTIONS');

export const defaultLiveOptions: LiveOptions = {
  revalidateMs: 60_000,
  pingIntervalMs: 30_000,
  idleTimeoutMs: 75_000,
};

const DEFAULT_WEB_URL = 'http://localhost:3517';

/** The one `Origin` a `/live` socket may come from: the web app's (`WEB_URL`). */
export const allowedLiveOrigin = (): string =>
  new URL(process.env.WEB_URL || DEFAULT_WEB_URL).origin;
