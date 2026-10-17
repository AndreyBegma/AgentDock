import { describe, expect, it } from 'bun:test';
import {
  normalizeServer,
  pairingUrl,
  ServerUrlError,
  socketUrl,
} from './server-url';

describe('server URLs', () => {
  it('puts pairing and the socket at the root of the API origin', () => {
    expect(pairingUrl('http://localhost:8180/')).toBe(
      'http://localhost:8180/runners/pair',
    );
    expect(socketUrl('http://localhost:8180')).toBe(
      'ws://localhost:8180/runner',
    );
    expect(socketUrl('https://dock.example')).toBe('wss://dock.example/runner');
  });

  it('keeps a path prefix the reverse proxy may add', () => {
    expect(socketUrl('https://example.com/dock/')).toBe(
      'wss://example.com/dock/runner',
    );
  });

  it('refuses plain http to a host that is not loopback (F-20)', () => {
    expect(() => normalizeServer('http://dock.lan')).toThrow(ServerUrlError);
    expect(() => normalizeServer('http://10.0.0.5:8180')).toThrow(
      ServerUrlError,
    );
    expect(() => socketUrl('http://dock.lan')).toThrow(ServerUrlError);
    expect(() => pairingUrl('http://dock.lan')).toThrow(ServerUrlError);
  });

  it('accepts plain http to loopback with no flag', () => {
    for (const server of [
      'http://127.0.0.1:8180',
      'http://127.1.2.3:8180',
      'http://localhost:8180',
      'http://[::1]:8180',
    ]) {
      expect(normalizeServer(server)).toBe(server);
    }
    expect(() => normalizeServer('http://127.0.0.1.evil.com')).toThrow(
      ServerUrlError,
    );
  });

  it('accepts plain http to any host when insecure is set', () => {
    expect(normalizeServer('http://dock.lan', true)).toBe('http://dock.lan');
    expect(socketUrl('http://dock.lan', true)).toBe('ws://dock.lan/runner');
  });

  it('refuses anything but a plain http(s) origin', () => {
    expect(() => normalizeServer('ftp://x')).toThrow(ServerUrlError);
    expect(() => normalizeServer('nope')).toThrow(ServerUrlError);
    expect(() => normalizeServer('https://u:p@x')).toThrow(ServerUrlError);
  });
});
