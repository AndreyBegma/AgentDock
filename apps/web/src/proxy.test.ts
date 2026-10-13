import { describe, expect, test } from 'bun:test';
import { SESSION_COOKIE } from '@agentdock/shared';
import { NextRequest } from 'next/server';
import { config, PUBLIC_FILES, proxy } from './proxy';

const ORIGIN = 'https://dock.example.com';

function visit(path: string, signedIn = false) {
  const headers = signedIn
    ? { cookie: `${SESSION_COOKIE}=session-token` }
    : undefined;
  return proxy(new NextRequest(`${ORIGIN}${path}`, { headers }));
}

/** Where a redirect goes, or null when the request passes through. */
const redirectOf = (response: Response): string | null =>
  response.headers.get('location');

describe('proxy', () => {
  test('/install is public', () => {
    expect(redirectOf(visit('/install'))).toBeNull();
  });

  test('the sign-in pages are public', () => {
    for (const path of ['/login', '/register', '/pending']) {
      expect(redirectOf(visit(path))).toBeNull();
    }
  });

  test('the routes around /install still need a session', () => {
    for (const path of ['/', '/install/x', '/installer', '/admin/runners']) {
      expect(redirectOf(visit(path))).toStartWith(`${ORIGIN}/login`);
    }
  });

  test('a signed-out visit keeps where it was going', () => {
    expect(redirectOf(visit('/admin/runners?add=1'))).toBe(
      `${ORIGIN}/login?next=${encodeURIComponent('/admin/runners?add=1')}`,
    );
  });

  test('a session lets every route through', () => {
    expect(redirectOf(visit('/admin/runners', true))).toBeNull();
  });

  test('the app icons load signed out (the login tab has its favicon)', () => {
    for (const path of ['/icon.svg', '/apple-icon.png', '/favicon.ico']) {
      expect(redirectOf(visit(path))).toBeNull();
    }
    expect(redirectOf(visit('/icon.svg?f0e1d2c3'))).toBeNull();
  });

  test('the matcher skips the icons and nothing that merely starts like them', () => {
    const matches = (path: string) =>
      config.matcher.some((pattern) => new RegExp(`^${pattern}$`).test(path));
    for (const path of PUBLIC_FILES) expect(matches(path)).toBe(false);
    for (const path of ['/', '/icon.svg/x', '/icons', '/admin/runners']) {
      expect(matches(path)).toBe(true);
    }
  });
});
