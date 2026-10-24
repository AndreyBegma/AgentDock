import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import {
  LOGIN_PATH,
  loginRedirect,
  needsSetup,
  SETUP_PATH,
  setupRedirect,
  setupToken,
} from './setup-redirect';

describe('loginRedirect', () => {
  it('sends the visitor to /setup while no account exists', () => {
    expect(loginRedirect(true)).toBe(SETUP_PATH);
  });

  it('keeps the form once set up, or when the API cannot say', () => {
    expect(loginRedirect(false)).toBeNull();
    expect(loginRedirect(null)).toBeNull();
  });
});

describe('setupRedirect', () => {
  it('sends the visitor to /login once an account exists', () => {
    expect(setupRedirect(false)).toBe(LOGIN_PATH);
  });

  it('keeps the setup form while needed, or when the API cannot say', () => {
    expect(setupRedirect(true)).toBeNull();
    expect(setupRedirect(null)).toBeNull();
  });

  it('never redirects both pages for the same answer', () => {
    for (const answer of [true, false, null]) {
      expect(
        loginRedirect(answer) !== null && setupRedirect(answer) !== null,
      ).toBe(false);
    }
  });
});

describe('setupToken', () => {
  it('takes one non-empty token', () => {
    expect(setupToken(' abc ')).toBe('abc');
    expect(setupToken(undefined)).toBeNull();
    expect(setupToken('  ')).toBeNull();
    expect(setupToken(['a', 'b'])).toBeNull();
  });
});

describe('needsSetup', () => {
  afterEach(() => mock.restore());

  const answer = (response: Response | Error) =>
    spyOn(globalThis, 'fetch').mockImplementation((() =>
      response instanceof Error
        ? Promise.reject(response)
        : Promise.resolve(response)) as unknown as typeof fetch);

  it('reads GET /setup/status', async () => {
    const fetchSpy = answer(Response.json({ needsSetup: true }));
    expect(await needsSetup()).toBe(true);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toEndWith('/setup/status');

    answer(Response.json({ needsSetup: false }));
    expect(await needsSetup()).toBe(false);
  });

  it('is null when the API errors or is down', async () => {
    answer(new Response('nope', { status: 503 }));
    expect(await needsSetup()).toBeNull();

    answer(new Error('ECONNREFUSED'));
    expect(await needsSetup()).toBeNull();
  });
});
