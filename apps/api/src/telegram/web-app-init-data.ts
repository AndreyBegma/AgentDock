import { createHmac, timingSafeEqual } from 'node:crypto';

/** #580: how old a Mini App's `initData` may be when it signs in. */
export const DEFAULT_INIT_DATA_MAX_AGE_S = 3600;
/** A clock this far ahead of ours still counts; further is a forgery. */
const FUTURE_SKEW_S = 60;
const HASH_SHAPE = /^[0-9a-f]{64}$/;
/** Telegram's own cap on `initData`; anything longer is not from it. */
const INIT_DATA_MAX = 4096;

/** What a verified `initData` vouches for. */
export interface WebAppInit {
  /** The Telegram user — in a private chat with the bot, also the chat id. */
  userId: number;
  username: string | null;
  authDate: Date;
  /** `startapp` of a direct link, else null. */
  startParam: string | null;
}

export type InitDataCheck =
  | { ok: true; init: WebAppInit }
  | { ok: false; reason: 'invalid' | 'expired' };

const invalid: InitDataCheck = { ok: false, reason: 'invalid' };

/** `HMAC_SHA256(key = "WebAppData", bot token)`: the key the hash is made with. */
const secretKey = (botToken: string): Buffer =>
  createHmac('sha256', 'WebAppData').update(botToken).digest();

/**
 * The `hash` Telegram puts on `initData`: every other field as `key=value`,
 * sorted by key and joined by `\n`, signed with `secretKey`. Exported for
 * tests, which sign their own `initData` with it.
 */
export const initDataHash = (
  fields: Iterable<[string, string]>,
  botToken: string,
): string => {
  const checkString = [...fields]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  return createHmac('sha256', secretKey(botToken))
    .update(checkString)
    .digest('hex');
};

const parseUser = (
  raw: string | null,
): { id: number; username: string | null } | null => {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { id, username } = value as Record<string, unknown>;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    return null;
  }
  return { id, username: typeof username === 'string' ? username : null };
};

/**
 * #580: checks a Mini App's `initData` the way Telegram's Web App rules say
 * — the HMAC of its fields with the bot token, compared in constant time —
 * and that `auth_date` is no older than `maxAgeS`. A field set twice is a
 * forgery: Telegram never sends one, and the check string would be ambiguous.
 */
export const verifyInitData = (
  initData: string,
  botToken: string,
  now: Date,
  maxAgeS = DEFAULT_INIT_DATA_MAX_AGE_S,
): InitDataCheck => {
  if (!initData || initData.length > INIT_DATA_MAX) return invalid;
  const params = new URLSearchParams(initData);
  const fields = [...params.entries()];
  if (new Set(fields.map(([key]) => key)).size !== fields.length) {
    return invalid;
  }
  const hash = params.get('hash');
  if (!hash || !HASH_SHAPE.test(hash)) return invalid;
  const expected = Buffer.from(initDataHash(fields, botToken), 'hex');
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return invalid;

  const authDate = Number(params.get('auth_date'));
  if (!Number.isSafeInteger(authDate) || authDate <= 0) return invalid;
  const user = parseUser(params.get('user'));
  if (!user) return invalid;
  const ageS = now.getTime() / 1000 - authDate;
  if (ageS < -FUTURE_SKEW_S) return invalid;
  if (ageS > maxAgeS) return { ok: false, reason: 'expired' };
  return {
    ok: true,
    init: {
      userId: user.id,
      username: user.username,
      authDate: new Date(authDate * 1000),
      startParam: params.get('start_param') || null,
    },
  };
};
