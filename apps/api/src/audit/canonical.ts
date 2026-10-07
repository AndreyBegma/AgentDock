import { createHash } from 'node:crypto';

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
    out[key] = REDACTED_KEYS.has(key) ? REDACTED : scrub(inner);
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
  action: string;
  targetType: string;
  targetId: string | null;
  projectId: string | null;
  before: JsonValue | null;
  after: JsonValue | null;
  result: string;
  meta: JsonValue | null;
}

/** sha256(prevHash ‖ canonical(record)), hex. */
export const computeHash = (prevHash: string, row: HashedFields): string => {
  const canonical = canonicalJson({
    seq: row.seq.toString(),
    ts: row.ts.toISOString(),
    actorType: row.actorType,
    actorUserId: row.actorUserId,
    actorRunnerId: row.actorRunnerId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    projectId: row.projectId,
    before: row.before,
    after: row.after,
    result: row.result,
    meta: row.meta,
  });
  return createHash('sha256').update(prevHash).update(canonical).digest('hex');
};
