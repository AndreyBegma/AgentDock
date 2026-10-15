import {
  type ApiErrorBody,
  AUTH_ERROR,
  type PublicUser,
  SESSION_COOKIE,
} from '@agentdock/shared';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const API_URL = process.env.API_URL ?? 'http://localhost:8180';

/**
 * The signed-in user for a segment layout (spec D6): `GET /auth/me` with the
 * request's session cookie. 401 → `/login`, a pending account → `/pending`.
 */
export async function requireUser(): Promise<PublicUser> {
  const session = (await cookies()).get(SESSION_COOKIE);
  if (!session) redirect('/login');

  const response = await fetch(`${API_URL}/auth/me`, {
    headers: { cookie: `${SESSION_COOKIE}=${session.value}` },
    cache: 'no-store',
  });
  if (response.ok) return (await response.json()) as PublicUser;

  const body = (await response
    .json()
    .catch(() => null)) as Partial<ApiErrorBody> | null;
  if (body?.error === AUTH_ERROR.pendingApproval) redirect('/pending');
  if (response.status === 401 || response.status === 403) redirect('/login');
  throw new Error(`GET /auth/me failed with ${response.status}`);
}

/**
 * The signed-in user, or null — for a page that works signed out (`/login`).
 * Anything but a 200 is null: a stale cookie, a pending account or an API
 * that is down all leave the visitor on the page, never in a redirect loop
 * with `requireUser`.
 */
export async function currentUser(): Promise<PublicUser | null> {
  const session = (await cookies()).get(SESSION_COOKIE);
  if (!session) return null;
  try {
    const response = await fetch(`${API_URL}/auth/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${session.value}` },
      cache: 'no-store',
    });
    return response.ok ? ((await response.json()) as PublicUser) : null;
  } catch {
    return null;
  }
}
