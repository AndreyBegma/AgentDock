import { describe, expect, test } from 'bun:test';
import { SESSION_COOKIE } from '@nautelle/shared';
import { NextRequest } from 'next/server';
import nextConfig from '../next.config';
import { config, PUBLIC_FILES, proxy } from './proxy';
import { contentSecurityPolicy, NONCE_HEADER } from './security-headers';

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
    for (const path of ['/login', '/register', '/pending', '/setup']) {
      expect(redirectOf(visit(path))).toBeNull();
    }
  });

  test('the Telegram Mini App entry is public, and nothing under it', () => {
    expect(redirectOf(visit('/tg?start=p1_2'))).toBeNull();
    expect(redirectOf(visit('/tg/x'))).toStartWith(`${ORIGIN}/login`);
  });

  test("only the Mini App entry runs Telegram's script", () => {
    const scripts = (path: string) =>
      directives(visit(path).headers.get('content-security-policy') ?? '').get(
        'script-src',
      ) ?? '';
    expect(scripts('/tg')).toContain('https://telegram.org');
    expect(scripts('/login')).not.toContain('telegram.org');
    expect(scripts('/projects')).not.toContain('telegram.org');
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
    for (const path of ['/icon.svg', '/apple-icon', '/favicon.ico']) {
      expect(redirectOf(visit(path))).toBeNull();
    }
    expect(redirectOf(visit('/icon.svg?f0e1d2c3'))).toBeNull();
  });

  test('the matcher skips the icons and nothing that merely starts like them', () => {
    const matches = (path: string) =>
      config.matcher.some((pattern) => new RegExp(`^${pattern}$`).test(path));
    for (const path of PUBLIC_FILES) expect(matches(path)).toBe(false);
    for (const path of ['/', '/icon.svg/x', '/apple-icons', '/admin/runners']) {
      expect(matches(path)).toBe(true);
    }
  });
});

/** The CSP's directives by name, e.g. `script-src` → `'self' 'nonce-…'`. */
function directives(csp: string): Map<string, string> {
  return new Map(
    csp.split(';').map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name, values.join(' ')];
    }),
  );
}

const nonceOf = (csp: string) =>
  /'nonce-([^']+)'/.exec(directives(csp).get('script-src') ?? '')?.[1];

describe('security headers (F-27)', () => {
  const PAGES = [
    { name: '/login', path: '/login', signedIn: false },
    { name: 'a project page', path: '/projects/p1/board', signedIn: true },
  ];

  for (const { name, path, signedIn } of PAGES) {
    test(`${name} carries every header`, () => {
      const headers = visit(path, signedIn).headers;
      expect(headers.get('x-frame-options')).toBe('DENY');
      expect(headers.get('referrer-policy')).toBe(
        'strict-origin-when-cross-origin',
      );
      expect(headers.get('permissions-policy')).toBe(
        'camera=(), microphone=(), geolocation=()',
      );
      expect(headers.get('x-content-type-options')).toBe('nosniff');
      // The test origin is https.
      expect(headers.get('strict-transport-security')).toBe('max-age=31536000');
      expect(headers.get('x-powered-by')).toBeNull();

      const csp = headers.get('content-security-policy') ?? '';
      const policy = directives(csp);
      const nonce = nonceOf(csp);
      expect(nonce).toBeString();
      expect(policy.get('default-src')).toBe("'self'");
      expect(policy.get('script-src')).toStartWith(`'self' 'nonce-${nonce}'`);
      expect(policy.get('script-src')).not.toContain("'unsafe-inline'");
      expect(policy.get('frame-src')).toBe("'self'");
      expect(policy.get('frame-ancestors')).toBe("'none'");
      expect(policy.get('object-src')).toBe("'none'");
      expect(policy.get('base-uri')).toBe("'self'");
      expect(policy.get('form-action')).toBe("'self'");
      expect(policy.get('connect-src')).toStartWith("'self'");
    });

    test(`${name} hands its nonce and policy on to the page`, () => {
      const response = visit(path, signedIn);
      const csp = response.headers.get('content-security-policy') ?? '';
      // NextResponse.next() forwards overridden request headers this way.
      expect(response.headers.get(`x-middleware-request-${NONCE_HEADER}`)).toBe(
        nonceOf(csp) ?? 'missing',
      );
      expect(
        response.headers.get('x-middleware-request-content-security-policy'),
      ).toBe(csp);
    });
  }

  test('the nonce is fresh on every request', () => {
    const nonces = new Set(
      Array.from({ length: 20 }, () =>
        nonceOf(visit('/login').headers.get('content-security-policy') ?? ''),
      ),
    );
    expect(nonces.size).toBe(20);
  });

  test('the sign-in redirect carries the headers too', () => {
    const response = visit('/projects/p1/board');
    expect(redirectOf(response)).toStartWith(`${ORIGIN}/login`);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toContain(
      "frame-ancestors 'none'",
    );
  });

  test('HSTS only when the browser came over TLS', () => {
    const plain = proxy(new NextRequest('http://localhost:3517/login'));
    expect(plain.headers.get('strict-transport-security')).toBeNull();
    // TLS ended at the reverse proxy (staging: Cloudflare → Caddy → web).
    const proxied = proxy(
      new NextRequest('http://web:3517/login', {
        headers: { 'x-forwarded-proto': 'https' },
      }),
    );
    expect(proxied.headers.get('strict-transport-security')).toBe(
      'max-age=31536000',
    );
  });

  test('connect-src allows the live / terminal socket origin', () => {
    const csp = contentSecurityPolicy({
      nonce: 'n',
      liveUrl: 'wss://dock.example.com/api/live',
      dev: false,
    });
    expect(directives(csp).get('connect-src')).toBe(
      "'self' wss://dock.example.com",
    );
    expect(directives(csp).get('script-src')).toBe("'self' 'nonce-n'");
  });

  test('a malformed live URL only drops the extra origin', () => {
    const csp = contentSecurityPolicy({
      nonce: 'n',
      liveUrl: 'nope',
      dev: true,
    });
    expect(directives(csp).get('connect-src')).toBe("'self'");
    expect(directives(csp).get('script-src')).toBe(
      "'self' 'nonce-n' 'unsafe-eval'",
    );
  });
});

test('next.config turns the X-Powered-By header off', () => {
  expect(nextConfig.poweredByHeader).toBe(false);
});
