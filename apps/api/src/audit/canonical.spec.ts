import {
  auditHmacKey,
  type ChainedRecord,
  ChainWalk,
  canonicalJson,
  chainHash,
  computeHash,
  computeKeyedHash,
  GENESIS_HASH,
  type HashedFields,
  REDACTED,
  redact,
} from './canonical';
import { csvCell, csvRow } from './csv';

const row = (overrides: Partial<HashedFields> = {}): HashedFields => ({
  seq: 1n,
  ts: new Date('2026-10-07T18:36:20.123Z'),
  actorType: 'user',
  actorUserId: 'u_1',
  actorRunnerId: null,
  action: 'auth.login',
  targetType: 'user',
  targetId: 'u_1',
  projectId: null,
  before: null,
  after: { b: 1, a: [2, { d: 3, c: 4 }] },
  result: 'ok',
  meta: null,
  ...overrides,
});

describe('canonicalJson', () => {
  it('sorts keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
      '{"a":[2,{"c":4,"d":3}],"b":1}',
    );
  });
});

describe('redact', () => {
  it('replaces every redacted key at any depth, including inside arrays', () => {
    expect(
      redact({
        email: 'a@example.com',
        password: 'p',
        nested: { tokenHash: 'h', list: [{ code: 'ABCD-EFGH', ok: true }] },
        secret: { anything: 1 },
      }),
    ).toEqual({
      email: 'a@example.com',
      password: REDACTED,
      nested: { tokenHash: REDACTED, list: [{ code: REDACTED, ok: true }] },
      secret: REDACTED,
    });
  });

  it('redacts keys that name a token, secret, password, key, authorization or cookie (C-174)', () => {
    expect(redact({ apiToken: 'x', clientSecret: 'y' })).toEqual({
      apiToken: REDACTED,
      clientSecret: REDACTED,
    });
    expect(
      redact({
        headers: {
          Authorization: 'Bearer t',
          Cookie: 'sid=1',
          'x-api-key': 'k',
        },
        DB_PASSWORD: 'p',
        pinCode: 1234,
        privateKey: 'pem',
        name: 'kept',
      }),
    ).toEqual({
      headers: {
        Authorization: REDACTED,
        Cookie: REDACTED,
        'x-api-key': REDACTED,
      },
      DB_PASSWORD: REDACTED,
      pinCode: 1234,
      privateKey: REDACTED,
      name: 'kept',
    });
  });

  it('walks an object under a matching key instead of dropping it whole', () => {
    expect(
      redact({
        tokenSaver: { enabled: true, mode: 'eco', webhookSecret: 's' },
        ignoredProfileKeys: ['a', 'b'],
        hasToken: true,
        tokenExpiry: null,
        profileKey: 'claude-opus',
      }),
    ).toEqual({
      tokenSaver: { enabled: true, mode: 'eco', webhookSecret: REDACTED },
      ignoredProfileKeys: ['a', 'b'],
      hasToken: true,
      tokenExpiry: null,
      profileKey: 'claude-opus',
    });
  });

  it('stores what JSON stores: Dates as ISO strings, undefined dropped', () => {
    expect(
      redact({ at: new Date('2026-10-07T00:00:00.000Z'), gone: undefined }),
    ).toEqual({ at: '2026-10-07T00:00:00.000Z' });
    expect(redact(undefined)).toBeNull();
  });
});

describe('computeHash', () => {
  it('is independent of key order and depends on every hashed field', () => {
    const base = computeHash(GENESIS_HASH, row());
    expect(
      computeHash(
        GENESIS_HASH,
        row({ after: { a: [2, { c: 4, d: 3 }], b: 1 } }),
      ),
    ).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    for (const change of [
      { seq: 2n },
      { ts: new Date('2026-10-07T18:36:20.124Z') },
      { actorUserId: 'u_2' },
      { action: 'auth.logout' },
      { targetId: null },
      { projectId: 'p' },
      { after: { b: 2 } },
      { result: 'denied' },
      { meta: { ip: '1.2.3.4' } },
    ] satisfies Partial<HashedFields>[]) {
      expect(computeHash(GENESIS_HASH, row(change))).not.toBe(base);
    }
    expect(computeHash('f'.repeat(64), row())).not.toBe(base);
  });
});

describe('computeKeyedHash (C-174)', () => {
  const KEY = 'k'.repeat(44);

  it('is an HMAC: it depends on the key and differs from the unkeyed hash', () => {
    const keyed = computeKeyedHash(KEY, GENESIS_HASH, row());
    expect(keyed).toMatch(/^[0-9a-f]{64}$/);
    expect(keyed).not.toBe(computeHash(GENESIS_HASH, row()));
    expect(computeKeyedHash(`${KEY}x`, GENESIS_HASH, row())).not.toBe(keyed);
    expect(computeKeyedHash(KEY, GENESIS_HASH, row({ seq: 2n }))).not.toBe(
      keyed,
    );
  });

  it('a new record is keyed only when the key is set', () => {
    expect(chainHash(KEY, GENESIS_HASH, row())).toBe(
      computeKeyedHash(KEY, GENESIS_HASH, row()),
    );
    expect(chainHash(null, GENESIS_HASH, row())).toBe(
      computeHash(GENESIS_HASH, row()),
    );
  });

  it('reads the key from AUDIT_HMAC_KEY; blank means unset', () => {
    expect(auditHmacKey({ AUDIT_HMAC_KEY: KEY })).toBe(KEY);
    expect(auditHmacKey({ AUDIT_HMAC_KEY: '  ' })).toBeNull();
    expect(auditHmacKey({})).toBeNull();
  });
});

describe('ChainWalk (C-174)', () => {
  const KEY = 'chain-key-'.repeat(4);

  /** A chain of `n` records; `keyed(i)` says which ones get the HMAC. */
  const chain = (
    n: number,
    keyed: (i: number) => boolean,
    key = KEY,
  ): ChainedRecord[] => {
    const rows: ChainedRecord[] = [];
    let prevHash = GENESIS_HASH;
    for (let i = 0; i < n; i += 1) {
      const fields = row({ seq: BigInt(i + 1), after: { n: i } });
      const hash = keyed(i)
        ? computeKeyedHash(key, prevHash, fields)
        : computeHash(prevHash, fields);
      rows.push({ ...fields, prevHash, hash });
      prevHash = hash;
    }
    return rows;
  };

  /** Index of the first record the walk rejects, or -1. */
  const firstBroken = (rows: ChainedRecord[], key: string | null = KEY) => {
    const walk = new ChainWalk(key);
    return rows.findIndex((r) => !walk.accept(r));
  };

  /** Rewrites record `at` and recomputes every later hash with `hash`. */
  const rewrite = (
    rows: ChainedRecord[],
    at: number,
    hash: (prevHash: string, fields: HashedFields) => string,
  ): ChainedRecord[] => {
    const out = rows.map((r) => ({ ...r }));
    out[at] = { ...out[at], after: { n: 'forged' } };
    let prevHash = out[at].prevHash;
    for (let i = at; i < out.length; i += 1) {
      out[i].prevHash = prevHash;
      out[i].hash = hash(prevHash, out[i]);
      prevHash = out[i].hash;
    }
    return out;
  };

  it('verifies a keyed chain, an unkeyed one, and unkeyed records followed by keyed ones', () => {
    expect(firstBroken(chain(5, () => true))).toBe(-1);
    expect(firstBroken(chain(5, () => false))).toBe(-1);
    expect(
      firstBroken(
        chain(5, () => false),
        null,
      ),
    ).toBe(-1);
    expect(firstBroken(chain(6, (i) => i >= 3))).toBe(-1);
  });

  it('rewriting a record and every later hash without the key breaks the chain at that record', () => {
    const rows = chain(6, (i) => i >= 2);
    // Recomputed unkeyed: an unkeyed record after a keyed one is refused.
    expect(firstBroken(rewrite(rows, 4, computeHash))).toBe(4);
    // Recomputed with a guessed key.
    const guessed = (p: string, f: HashedFields) =>
      computeKeyedHash('not the key', p, f);
    expect(firstBroken(rewrite(rows, 4, guessed))).toBe(4);
    // An unkeyed record before the switch: the first keyed record no longer verifies.
    expect(firstBroken(rewrite(rows, 1, computeHash).slice(0, 3))).toBe(-1);
    const forgedPrefix = rewrite(rows, 1, computeHash);
    forgedPrefix[2] = rows[2];
    expect(firstBroken(forgedPrefix)).toBe(2);
    // With the key, the same rewrite verifies — the key is what protects it.
    const withKey = (p: string, f: HashedFields) => computeKeyedHash(KEY, p, f);
    expect(firstBroken(rewrite(rows, 4, withKey))).toBe(-1);
  });

  it('refuses a broken link and, without the key, every keyed record', () => {
    const rows = chain(4, (i) => i >= 2);
    const relinked = rows.map((r) => ({ ...r }));
    relinked[1].prevHash = 'f'.repeat(64);
    expect(firstBroken(relinked)).toBe(1);
    expect(firstBroken(rows, null)).toBe(2);
    expect(firstBroken(rows, 'another key')).toBe(2);
  });
});

describe('computeHash and onBehalfOf (#102)', () => {
  // A system record as written before #102. The literal was computed by the
  // code on `develop` before the field existed: a stored record must keep
  // hashing to it, or verification breaks for every existing chain.
  const PRE_102_HASH =
    'beed6d84dd320a58b272877942c4daac0fe3a09a1257566524c2b37174bfe2a3';
  const legacy: HashedFields = {
    seq: 7n,
    ts: new Date('2026-10-07T18:36:20.123Z'),
    actorType: 'system',
    actorUserId: null,
    actorRunnerId: null,
    action: 'skill.run',
    targetType: 'run',
    targetId: 'r_1',
    projectId: 'p_1',
    before: null,
    after: { skill: 'review', args: '' },
    result: 'ok',
    meta: null,
  };

  it('a record without it hashes exactly as before — absent or null', () => {
    expect(computeHash(GENESIS_HASH, legacy)).toBe(PRE_102_HASH);
    expect(
      computeHash(GENESIS_HASH, { ...legacy, actorOnBehalfOfId: null }),
    ).toBe(PRE_102_HASH);
  });

  it('is covered by the hash when set', () => {
    const forU1 = computeHash(GENESIS_HASH, {
      ...legacy,
      actorOnBehalfOfId: 'u_1',
    });
    expect(forU1).not.toBe(PRE_102_HASH);
    expect(
      computeHash(GENESIS_HASH, { ...legacy, actorOnBehalfOfId: 'u_2' }),
    ).not.toBe(forU1);
  });
});

describe('csv', () => {
  it('quotes per RFC 4180 and serialises objects as JSON', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell({ a: 'x,y' })).toBe('"{""a"":""x,y""}"');
    expect(csvCell(12n)).toBe('12');
    expect(csvRow(['a', null, 'b'])).toBe('a,,b\r\n');
  });

  it('neutralises cells a spreadsheet would run as a formula', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
});
