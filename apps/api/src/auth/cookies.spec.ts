import { CSRF_COOKIE, SESSION_COOKIE } from '@nautelle/shared';
import type { Response } from 'express';
import { setSessionCookies } from './cookies';

const original = process.env.APP_ENV;

afterEach(() => {
  if (original === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = original;
});

const issue = (): Record<string, { secure?: boolean }> => {
  const sent: Record<string, { secure?: boolean }> = {};
  const response = {
    cookie: (name: string, _value: string, options: { secure?: boolean }) => {
      sent[name] = options;
    },
  } as unknown as Response;
  setSessionCookies(response, {
    token: 't',
    csrfToken: 'c',
  } as Parameters<typeof setSessionCookies>[1]);
  return sent;
};

describe('session cookies', () => {
  it('are Secure when APP_ENV is unset', () => {
    delete process.env.APP_ENV;
    const sent = issue();
    expect(sent[SESSION_COOKIE].secure).toBe(true);
    expect(sent[CSRF_COOKIE].secure).toBe(true);
  });

  it('are Secure under production', () => {
    process.env.APP_ENV = 'production';
    expect(issue()[SESSION_COOKIE].secure).toBe(true);
  });

  it.each(['development', 'test'])('are not Secure under %s', (env) => {
    process.env.APP_ENV = env;
    const sent = issue();
    expect(sent[SESSION_COOKIE].secure).toBe(false);
    expect(sent[CSRF_COOKIE].secure).toBe(false);
  });
});
