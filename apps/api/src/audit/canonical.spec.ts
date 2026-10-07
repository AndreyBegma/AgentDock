import {
  canonicalJson,
  computeHash,
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
