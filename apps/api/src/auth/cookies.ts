import { CSRF_COOKIE, SESSION_COOKIE } from '@agentdock/shared';
import type { CookieOptions, Response } from 'express';
import type { IssuedSession } from './session.service';
import { SESSION_ABSOLUTE_MS } from './session.service';

const baseOptions = (): CookieOptions => ({
  secure: process.env.APP_ENV === 'production',
  sameSite: 'lax',
  path: '/',
});

export const setSessionCookies = (
  response: Response,
  session: IssuedSession,
): void => {
  response.cookie(SESSION_COOKIE, session.token, {
    ...baseOptions(),
    httpOnly: true,
    maxAge: SESSION_ABSOLUTE_MS,
  });
  // Readable by the web app, which echoes it in X-CSRF-Token.
  response.cookie(CSRF_COOKIE, session.csrfToken, {
    ...baseOptions(),
    httpOnly: false,
    maxAge: SESSION_ABSOLUTE_MS,
  });
};

export const clearSessionCookies = (response: Response): void => {
  response.clearCookie(SESSION_COOKIE, { ...baseOptions(), httpOnly: true });
  response.clearCookie(CSRF_COOKIE, { ...baseOptions(), httpOnly: false });
};
