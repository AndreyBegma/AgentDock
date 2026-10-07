import { SESSION_COOKIE } from '@agentdock/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const PUBLIC_PATHS = ['/login', '/register', '/pending'];

/**
 * Route protection (spec D13). Next 16 renamed `middleware` to `proxy`; this is
 * the same hook. It only checks that a session cookie exists — the pages ask
 * `GET /api/auth/me` and redirect on 401 / pending_approval.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.includes(pathname)) return NextResponse.next();
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();
  return NextResponse.redirect(new URL('/login', request.url));
}

export const config = {
  // Everything except the API rewrite and Next internals / static files.
  matcher: ['/((?!api/|_next/|favicon.ico).*)'],
};
