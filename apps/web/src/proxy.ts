import { MINI_APP_PATH, SESSION_COOKIE } from '@agentdock/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { HOME_PATH, safeNext } from './app/login/safe-next';
import { INSTALL_PATH } from './lib/runners/install';
import {
  contentSecurityPolicy,
  createNonce,
  NONCE_HEADER,
  securityHeaders,
} from './security-headers';

/**
 * Exact paths only: a prefix would open everything under it. The Telegram
 * Mini App's entry (#580) signs in with Telegram's `initData`, not a cookie.
 */
const PUBLIC_PATHS = [
  '/login',
  '/register',
  '/pending',
  INSTALL_PATH,
  MINI_APP_PATH,
];

/**
 * The app icons (`app/icon.svg`, and `app/apple-icon.tsx`, served at
 * `/apple-icon`) are fetched by the browser on the sign-in page too;
 * redirected, the tab shows no icon there.
 */
export const PUBLIC_FILES = ['/favicon.ico', '/icon.svg', '/apple-icon'];

/**
 * Route protection (spec D13). Next 16 renamed `middleware` to `proxy`; this is
 * the same hook. It only checks that a session cookie exists — the pages ask
 * `GET /api/auth/me` and redirect on 401 / pending_approval.
 *
 * Every response it lets through or redirects carries the security headers
 * (F-27), with a Content-Security-Policy whose nonce is fresh per request.
 */
export function proxy(request: NextRequest) {
  const nonce = createNonce();
  const csp = contentSecurityPolicy({
    nonce,
    telegram: request.nextUrl.pathname === MINI_APP_PATH,
  });
  const response = route(request, nonce, csp);
  const headers = securityHeaders({
    csp,
    protocol: request.nextUrl.protocol,
    forwardedProto: request.headers.get('x-forwarded-proto'),
  });
  for (const [name, value] of Object.entries(headers)) {
    response.headers.set(name, value);
  }
  return response;
}

function route(request: NextRequest, nonce: string, csp: string) {
  const { pathname } = request.nextUrl;
  if (
    PUBLIC_PATHS.includes(pathname) ||
    PUBLIC_FILES.includes(pathname) ||
    request.cookies.has(SESSION_COOKIE)
  ) {
    // Next reads the nonce off the request's CSP and puts it on its own
    // scripts; the layout reads `NONCE_HEADER` for the theme bootstrap.
    const forwarded = new Headers(request.headers);
    forwarded.set(NONCE_HEADER, nonce);
    forwarded.set('content-security-policy', csp);
    return NextResponse.next({ request: { headers: forwarded } });
  }
  const login = new URL('/login', request.url);
  // Login sends the user back here; it accepts only a same-origin path.
  const next = safeNext(`${pathname}${request.nextUrl.search}`);
  if (next !== HOME_PATH) login.searchParams.set('next', next);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except the API rewrite, Next internals and the app icons
  // (`PUBLIC_FILES`, kept in step with this list).
  matcher: ['/((?!api/|_next/|favicon\\.ico$|icon\\.svg$|apple-icon$).*)'],
};
