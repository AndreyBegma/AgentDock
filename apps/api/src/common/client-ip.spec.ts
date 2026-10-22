import type { IncomingMessage } from 'node:http';
import { clientIp, compileTrust } from './client-ip';

const upgrade = (peer: string | undefined, forwardedFor?: string) =>
  ({
    socket: { remoteAddress: peer },
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
  }) as unknown as IncomingMessage;

describe('clientIp', () => {
  it('believes X-Forwarded-For from a trusted proxy', () => {
    expect(
      clientIp(upgrade('127.0.0.1', '203.0.113.7'), compileTrust('loopback')),
    ).toBe('203.0.113.7');
  });

  it('keeps the peer when the peer is not trusted', () => {
    expect(
      clientIp(
        upgrade('198.51.100.2', '203.0.113.7'),
        compileTrust('loopback'),
      ),
    ).toBe('198.51.100.2');
    expect(
      clientIp(upgrade('127.0.0.1', '203.0.113.7'), compileTrust(false)),
    ).toBe('127.0.0.1');
  });

  it('walks only as many hops as a hop count allows', () => {
    const request = upgrade('10.0.0.1', '203.0.113.7, 10.0.0.9');
    expect(clientIp(request, compileTrust(1))).toBe('10.0.0.9');
    expect(clientIp(request, compileTrust(2))).toBe('203.0.113.7');
  });

  it('is undefined without a peer address', () => {
    expect(clientIp(upgrade(undefined), compileTrust(true))).toBeUndefined();
  });

  it('reads TRUST_PROXY by default', () => {
    const saved = process.env.TRUST_PROXY;
    try {
      process.env.TRUST_PROXY = 'loopback';
      expect(clientIp(upgrade('127.0.0.1', '203.0.113.7'))).toBe('203.0.113.7');
      process.env.TRUST_PROXY = 'false';
      expect(clientIp(upgrade('127.0.0.1', '203.0.113.7'))).toBe('127.0.0.1');
    } finally {
      if (saved === undefined) delete process.env.TRUST_PROXY;
      else process.env.TRUST_PROXY = saved;
    }
  });
});
