import { SESSION_COOKIE } from '@agentdock/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { HOME_PATH, safeNext } from './app/login/safe-next';
import { INSTALL_PATH } from './lib/runners/install';

/** Exact paths only: a prefix would open everything under it. */
const PUBLIC_PATHS = ['/login', '/register', '/pending', INSTALL_PATH];

/**
 * The app icons (`app/icon.svg`, `app/apple-icon.png`) are fetched by the
 * browser on the sign-in page too; redirected, the tab shows no icon there.
 */
export const PUBLIC_FILES = ['/favicon.ico', '/icon.svg', '/apple-icon.png'];

/**
 * Route protection (spec D13). Next 16 renamed `middleware` to `proxy`; this is
 * the same hook. It only checks that a session cookie exists — the pages ask
 * `GET /api/auth/me` and redirect on 401 / pending_approval.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.includes(pathname)) return NextResponse.next();
  if (PUBLIC_FILES.includes(pathname)) return NextResponse.next();
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();
  const login = new URL('/login', request.url);
  // Login sends the user back here; it accepts only a same-origin path.
  const next = safeNext(`${pathname}${request.nextUrl.search}`);
  if (next !== HOME_PATH) login.searchParams.set('next', next);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except the API rewrite, Next internals and the app icons
  // (`PUBLIC_FILES`, kept in step with this list).
  matcher: [
    '/((?!api/|_next/|favicon\\.ico$|icon\\.svg$|apple-icon\\.png$).*)',
  ],
};
