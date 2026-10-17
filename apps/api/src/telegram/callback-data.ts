/**
 * #500: the typed `callback_data` of the bot's inline buttons. A codec is a
 * prefix and an ordered list of typed fields, `<prefix>:<field>:<field>…`.
 * Its longest possible payload is computed when it is defined, and a codec
 * that could pass Telegram's 64-byte cap is refused there: no button can be
 * built that Telegram would reject. Decoding never throws — anything the bot
 * did not put on a button is null.
 *
 * Cards and projects are carried by short ids: a card by its 8-character
 * `shortId`, a project by its id. A button names its own project, so pressing
 * it never depends on the chat's current project.
 */

/** The largest PostgreSQL `int8`; a longer id names no row. */
const INT8_MAX = 9223372036854775807n;

/** Whether `digits` (1–19 decimal digits) fits a database id. */
export const fitsInt8 = (digits: string): boolean => BigInt(digits) <= INT8_MAX;

/** Telegram limits `callback_data` to 64 bytes. */
export const CALLBACK_DATA_MAX = 64;

/**
 * Prefixes the hand-written codecs already use on buttons out in chats:
 * `a`/`r` approvals (#82), `x`/`y` action requests (spec 201 D18), `q`
 * question options (#489). A new codec may not take one.
 */
export const LEGACY_CALLBACK_PREFIXES = ['a', 'r', 'x', 'y', 'q'] as const;

/** What a field holds, its shape, and its longest encoding. */
const FIELDS = {
  /** A project id (a cuid). */
  project: { shape: /^[A-Za-z0-9_-]{1,32}$/, max: 32 },
  /** A board card's `shortId`. */
  card: { shape: /^[a-z0-9]{8}$/, max: 8 },
  /** A non-negative integer below 10^15. */
  int: { shape: /^(0|[1-9]\d{0,14})$/, max: 15 },
  /** A short fixed word: an action, a column. */
  word: { shape: /^[a-z0-9_]{1,16}$/, max: 16 },
  /** #578: a Git head's first 12 hex digits — what a merge button binds to. */
  sha: { shape: /^[0-9a-f]{12}$/, max: 12 },
} as const;

export type CallbackFieldKind = keyof typeof FIELDS;

type FieldValue<K extends CallbackFieldKind> = K extends 'int'
  ? number
  : string;

export type CallbackValues<F extends Record<string, CallbackFieldKind>> = {
  [K in keyof F]: FieldValue<F[K]>;
};

export interface CallbackCodec<F extends Record<string, CallbackFieldKind>> {
  readonly prefix: string;
  /** The longest payload this codec can produce, in bytes. */
  readonly maxBytes: number;
  /** Throws on a value of the wrong shape: that is a bug, not input. */
  encode(values: CallbackValues<F>): string;
  /** Null for anything that is not this codec's payload. */
  decode(data: string | undefined): CallbackValues<F> | null;
  /** Whether `data` carries this codec's prefix (decoding may still fail). */
  matches(data: string | undefined): boolean;
}

const PREFIX = /^[a-z]{1,4}$/;
const taken = new Set<string>(LEGACY_CALLBACK_PREFIXES);

export const callbackCodec = <
  const F extends Record<string, CallbackFieldKind>,
>(
  prefix: string,
  fields: F,
): CallbackCodec<F> => {
  if (!PREFIX.test(prefix)) {
    throw new Error(`callback prefix "${prefix}" is not 1–4 letters`);
  }
  if (taken.has(prefix)) {
    throw new Error(`callback prefix "${prefix}" is already taken`);
  }
  const names = Object.keys(fields) as (keyof F & string)[];
  const kinds = names.map((name) => fields[name]);
  // Plain ASCII throughout: a character is a byte.
  const maxBytes = kinds.reduce(
    (sum, kind) => sum + 1 + FIELDS[kind].max,
    prefix.length,
  );
  if (maxBytes > CALLBACK_DATA_MAX) {
    throw new Error(
      `callback "${prefix}" can reach ${maxBytes} bytes; Telegram allows ${CALLBACK_DATA_MAX}`,
    );
  }
  taken.add(prefix);

  const encodeField = (kind: CallbackFieldKind, value: unknown): string => {
    const text =
      kind === 'int'
        ? Number.isSafeInteger(value)
          ? String(value)
          : ''
        : typeof value === 'string'
          ? value
          : '';
    if (!FIELDS[kind].shape.test(text)) {
      throw new Error(`callback "${prefix}": not a ${kind}`);
    }
    return text;
  };

  return {
    prefix,
    maxBytes,
    encode: (values) =>
      [
        prefix,
        ...names.map((name, i) => encodeField(kinds[i], values[name])),
      ].join(':'),
    decode: (data) => {
      if (typeof data !== 'string' || data.length > CALLBACK_DATA_MAX) {
        return null;
      }
      const parts = data.split(':');
      if (parts[0] !== prefix || parts.length !== names.length + 1) {
        return null;
      }
      const values: Record<string, string | number> = {};
      for (const [i, name] of names.entries()) {
        const text = parts[i + 1];
        const kind = kinds[i];
        if (!FIELDS[kind].shape.test(text)) return null;
        values[name] = kind === 'int' ? Number(text) : text;
      }
      return values as CallbackValues<F>;
    },
    matches: (data) =>
      typeof data === 'string' && data.startsWith(`${prefix}:`),
  };
};
