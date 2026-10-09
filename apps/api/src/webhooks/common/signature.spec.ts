import {
  signInbound,
  signOutbound,
  verifyInboundSignature,
  verifyOutboundSignature,
} from './signature';

const SECRET = 'q8pTt2y0nqEJ6zY1kQm3fYxG9uWl4hHb2cV7sAe5RdI';
const OTHER = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
const NOW = new Date('2026-10-09T12:00:00.000Z');
const TS = String(Math.floor(NOW.getTime() / 1000));
const BODY = Buffer.from('{"branch":"main","run":{"id":42}}');
const DELIVERY = 'gh-run-42-attempt-1';

const signed = (
  overrides: Partial<Parameters<typeof verifyInboundSignature>[0]> = {},
) =>
  verifyInboundSignature({
    timestamp: TS,
    deliveryId: DELIVERY,
    signature: signInbound(SECRET, TS, DELIVERY, BODY),
    rawBody: BODY,
    secrets: [SECRET],
    now: NOW,
    ...overrides,
  });

describe('verifyInboundSignature (D2)', () => {
  it('accepts a correctly signed delivery', () => {
    expect(signed()).toEqual({ ok: true });
  });

  it('signs "<timestamp>.<delivery>.<raw body>" as sha256=<hex>', () => {
    expect(signInbound(SECRET, TS, DELIVERY, BODY)).toMatch(
      /^sha256=[0-9a-f]{64}$/,
    );
  });

  it('refuses a wrong signature', () => {
    expect(
      signed({ signature: signInbound(OTHER, TS, DELIVERY, BODY) }),
    ).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(signed({ signature: 'sha256=nothex' })).toMatchObject({ ok: false });
    expect(signed({ signature: 'sha1=abc' })).toMatchObject({ ok: false });
  });

  it('refuses a body changed by one byte', () => {
    const changed = Buffer.from(BODY);
    changed[changed.length - 2] ^= 1;
    expect(signed({ rawBody: changed })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('binds the delivery id and the timestamp into the signature', () => {
    expect(signed({ deliveryId: 'another-id' })).toMatchObject({ ok: false });
    const later = String(Number(TS) + 1);
    expect(signed({ timestamp: later })).toMatchObject({ ok: false });
  });

  it.each([
    ['timestamp'],
    ['deliveryId'],
    ['signature'],
  ] as const)('refuses a missing %s header', (header) => {
    expect(signed({ [header]: undefined })).toEqual({
      ok: false,
      reason: 'missing_header',
    });
  });

  it('refuses a timestamp 6 minutes old or ahead, accepts 5', () => {
    const at = (offsetSec: number) => String(Number(TS) + offsetSec);
    for (const offset of [-360, 360]) {
      const timestamp = at(offset);
      expect(
        signed({
          timestamp,
          signature: signInbound(SECRET, timestamp, DELIVERY, BODY),
        }),
      ).toEqual({ ok: false, reason: 'stale_timestamp' });
    }
    const timestamp = at(-300);
    expect(
      signed({
        timestamp,
        signature: signInbound(SECRET, timestamp, DELIVERY, BODY),
      }),
    ).toEqual({ ok: true });
  });

  it('refuses a malformed timestamp or delivery id', () => {
    expect(signed({ timestamp: '12.5' })).toMatchObject({
      reason: 'bad_timestamp',
    });
    expect(signed({ deliveryId: 'x'.repeat(65) })).toMatchObject({
      reason: 'bad_delivery_id',
    });
    expect(signed({ deliveryId: 'has space' })).toMatchObject({
      reason: 'bad_delivery_id',
    });
  });

  it('accepts the previous secret during rotation (D17) and nothing else', () => {
    const byOld = signInbound(OTHER, TS, DELIVERY, BODY);
    expect(signed({ signature: byOld, secrets: [SECRET, OTHER] })).toEqual({
      ok: true,
    });
    expect(signed({ signature: byOld, secrets: [SECRET] })).toMatchObject({
      ok: false,
    });
    expect(signed({ secrets: [] })).toMatchObject({ ok: false });
  });
});

describe('outbound signature (D13)', () => {
  const body = JSON.stringify({ id: 'test_1', type: 'webhook.test' });

  it('signs t=<unix>,v1=<hex> and the receiver recipe verifies it', () => {
    const header = signOutbound(SECRET, body, NOW);
    expect(header).toMatch(new RegExp(`^t=${TS},v1=[0-9a-f]{64}$`));
    expect(verifyOutboundSignature(header, body, SECRET, { now: NOW })).toBe(
      true,
    );
  });

  it('fails with another secret, a changed body, or an old timestamp', () => {
    const header = signOutbound(SECRET, body, NOW);
    expect(verifyOutboundSignature(header, body, OTHER, { now: NOW })).toBe(
      false,
    );
    expect(
      verifyOutboundSignature(header, `${body} `, SECRET, { now: NOW }),
    ).toBe(false);
    const later = new Date(NOW.getTime() + 6 * 60 * 1000);
    expect(verifyOutboundSignature(header, body, SECRET, { now: later })).toBe(
      false,
    );
  });

  it('after rotation the new secret verifies and the old does not', () => {
    const header = signOutbound(OTHER, body, NOW);
    expect(verifyOutboundSignature(header, body, OTHER, { now: NOW })).toBe(
      true,
    );
    expect(verifyOutboundSignature(header, body, SECRET, { now: NOW })).toBe(
      false,
    );
  });

  it('refuses malformed headers', () => {
    for (const header of [undefined, '', 'v1=abc', `t=${TS}`, 'garbage']) {
      expect(verifyOutboundSignature(header, body, SECRET, { now: NOW })).toBe(
        false,
      );
    }
  });
});
