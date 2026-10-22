import { createHash, createHmac } from 'node:crypto';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** `prevHash` of the first record (spec D1). */
export const GENESIS_HASH = '0'.repeat(64);

export const REDACTED = '[redacted]';

/** Keys whose values never reach a record, at any depth (spec D7). */
export const REDACTED_KEYS: ReadonlySet<string> = new Set([
  'password',
  'passwordHash',
  'currentPassword',
  'newPassword',
  'token',
  'tokenHash',
  'code',
  'codeHash',
  'secret',
]);

/**
 * Key names redacted on top of the list (C-174): anything that names a token,
 * secret, password, key, authorization or cookie — `apiToken`, `clientSecret`,
 * `x-api-key`, `Authorization` — whatever the module that audits it calls it.
 * A matching key's string or number is redacted; an object or array under it
 * is walked instead, so a settings group such as `tokenSaver: { … }` keeps
 * its harmless fields and still loses any secret inside.
 */
export const REDACTED_KEY_PATTERN =
  /token|secret|password|key|authorization|cookie/i;

/** Names the pattern matches that are identifiers, never secrets. */
export const NOT_SECRET_KEYS: ReadonlySet<string> = new Set(['profileKey']);

/**
 * A JSON-safe copy with every redacted key's value replaced. Goes through
 * `JSON.stringify` semantics first (Dates become ISO strings, `undefined`
 * keys vanish), so what is hashed is exactly what jsonb stores.
 */
export const redact = (value: unknown): JsonValue | null => {
  if (value === undefined) return null;
  const json = JSON.stringify(value);
  if (json === undefined) return null;
  return scrub(JSON.parse(json) as JsonValue);
};

const scrub = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(scrub);
  if (value === null || typeof value !== 'object') return value;
  const out: JsonObject = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = REDACTED_KEYS.has(key)
      ? REDACTED
      : REDACTED_KEY_PATTERN.test(key) &&
          !NOT_SECRET_KEYS.has(key) &&
          (typeof inner === 'string' || typeof inner === 'number')
        ? REDACTED
        : scrub(inner);
  }
  return out;
};

/** JSON with object keys sorted at every depth; arrays keep their order. */
export const canonicalJson = (value: JsonValue): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
};

/** The fields a record's hash covers (spec D1). */
export interface HashedFields {
  seq: bigint;
  ts: Date;
  actorType: string;
  actorUserId: string | null;
  actorRunnerId: string | null;
  /** Hashed only when set (#102), so a record without it hashes as before. */
  actorOnBehalfOfId?: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  projectId: string | null;
  before: JsonValue | null;
  after: JsonValue | null;
  result: string;
  meta: JsonValue | null;
}

const canonicalRecord = (row: HashedFields): string =>
  canonicalJson({
    seq: row.seq.toString(),
    ts: row.ts.toISOString(),
    actorType: row.actorType,
    actorUserId: row.actorUserId,
    actorRunnerId: row.actorRunnerId,
    ...(row.actorOnBehalfOfId
      ? { actorOnBehalfOfId: row.actorOnBehalfOfId }
      : {}),
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    projectId: row.projectId,
    before: row.before,
    after: row.after,
    result: row.result,
    meta: row.meta,
  });

/**
 * sha256(prevHash ‖ canonical(record)), hex — the unkeyed hash of every record
 * written before C-174, and of every record written without `AUDIT_HMAC_KEY`.
 */
export const computeHash = (prevHash: string, row: HashedFields): string =>
  createHash('sha256')
    .update(prevHash)
    .update(canonicalRecord(row))
    .digest('hex');

/**
 * HMAC-SHA256(key, prevHash ‖ canonical(record)), hex (C-174). Without the
 * key, which lives in the environment and never in the database, nobody can
 * rewrite a record and recompute the chain after it.
 */
export const computeKeyedHash = (
  key: string,
  prevHash: string,
  row: HashedFields,
): string =>
  createHmac('sha256', key)
    .update(prevHash)
    .update(canonicalRecord(row))
    .digest('hex');

export const AUDIT_HMAC_KEY_ENV = 'AUDIT_HMAC_KEY';

/** The chain key, read on every use; null when unset or blank. */
export const auditHmacKey = (
  env: NodeJS.ProcessEnv = process.env,
): string | null => env[AUDIT_HMAC_KEY_ENV]?.trim() || null;

/** The hash a new record gets: keyed when the key is set (C-174). */
export const chainHash = (
  key: string | null,
  prevHash: string,
  row: HashedFields,
): string =>
  key === null
    ? computeHash(prevHash, row)
    : computeKeyedHash(key, prevHash, row);

/** A stored record as the chain walk reads it. */
export interface ChainedRecord extends HashedFields {
  prevHash: string;
  hash: string;
}

/**
 * Walks the chain one record at a time, in `seq` order (spec D6). A record
 * verifies by its HMAC under `key` (C-174), or by the unkeyed sha256 only while
 * no keyed record came before it: unkeyed records are the prefix written before
 * the key was set, never a record inside the keyed chain, so rewriting one
 * there — and every hash after it — without the key breaks the chain.
 */
export class ChainWalk {
  private prevHash = GENESIS_HASH;
  private keyedSeen = false;

  constructor(private readonly key: string | null) {}

  /** True when `row` links to the record before it and its hash verifies. */
  accept(row: ChainedRecord): boolean {
    if (row.prevHash !== this.prevHash) return false;
    const keyed =
      this.key !== null &&
      computeKeyedHash(this.key, row.prevHash, row) === row.hash;
    if (!keyed) {
      if (this.keyedSeen) return false;
      if (computeHash(row.prevHash, row) !== row.hash) return false;
    }
    this.keyedSeen ||= keyed;
    this.prevHash = row.hash;
    return true;
  }
}
