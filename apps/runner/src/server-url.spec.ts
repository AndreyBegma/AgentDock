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

  it('refuses anything but a plain http(s) origin', () => {
    expect(() => normalizeServer('ftp://x')).toThrow(ServerUrlError);
    expect(() => normalizeServer('nope')).toThrow(ServerUrlError);
    expect(() => normalizeServer('https://u:p@x')).toThrow(ServerUrlError);
  });
});
