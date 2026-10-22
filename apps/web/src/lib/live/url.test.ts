import { describe, expect, it } from 'bun:test';
import { liveSocketUrl } from './url';

const https = {
  protocol: 'https:',
  host: 'dock.example.com',
  hostname: 'dock.example.com',
};
const http = {
  protocol: 'http:',
  host: 'localhost:3517',
  hostname: 'localhost',
};

describe('liveSocketUrl', () => {
  it('gives a wss: URL on an https origin without configuration', () => {
    expect(liveSocketUrl(undefined, https)).toBe(
      'wss://dock.example.com/api/live',
    );
  });

  it('upgrades a configured ws: URL on an https origin', () => {
    expect(liveSocketUrl('ws://dock.example.com/api/live', https)).toBe(
      'wss://dock.example.com/api/live',
    );
  });

  it('keeps a configured URL on http', () => {
    expect(liveSocketUrl('ws://h:8180/live', http)).toBe('ws://h:8180/live');
  });

  it('points at the API port on http without configuration', () => {
    expect(liveSocketUrl(undefined, http)).toBe('ws://localhost:8180/live');
  });

  it('falls back outside a browser', () => {
    expect(liveSocketUrl(undefined, undefined)).toBe(
      'ws://localhost:8180/live',
    );
  });
});
