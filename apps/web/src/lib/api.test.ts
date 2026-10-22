import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { AUTH_ERROR } from '@nautelle/shared';
import {
  ApiError,
  ApiUnreachableError,
  api,
  apiRuntime,
  describeError,
  describeErrorHint,
  errorText,
  errorToastOptions,
  isSafeApiPath,
  RESTARTING_READ_MESSAGE,
  RESTARTING_WRITE_MESSAGE,
  toErrorHint,
  UNSAFE_PATH_MESSAGE,
  UnsafeApiPathError,
} from './api';
import { reachability } from './live/reachability';

describe('error hints', () => {
  test('a plain sentence becomes a hint with no fix', () => {
    expect(toErrorHint('Nope.')).toEqual({ text: 'Nope.' });
    expect(errorText('Nope.')).toBe('Nope.');
  });

  test('a hint passes through', () => {
    const hint = {
      text: 'Runner offline.',
      href: '/admin/runners',
      cta: 'Open Runners',
    };
    expect(toErrorHint(hint)).toBe(hint);
    expect(errorText(hint)).toBe('Runner offline.');
  });

  test('a toast gets an action that navigates to the fix', () => {
    const navigate = mock((_href: string) => {});
    const options = errorToastOptions(
      { text: 'Runner offline.', href: '/admin/runners', cta: 'Open Runners' },
      navigate,
    );
    expect(options.action?.label).toBe('Open Runners');
    options.action?.onClick();
    expect(navigate).toHaveBeenCalledWith('/admin/runners');
  });

  test('a toast without a fix has no action', () => {
    const navigate = mock((_href: string) => {});
    expect(errorToastOptions('Nope.', navigate)).toEqual({});
    expect(errorToastOptions({ text: 'Nope.', href: '/x' }, navigate)).toEqual(
      {},
    );
  });

  test('describeError stays a string, and the hint carries the same text', () => {
    const error = new ApiError(429, undefined, 'Too Many Requests');
    expect(describeError(error)).toBe(
      'Too many attempts. Wait a minute and try again.',
    );
    expect(describeErrorHint(error)).toEqual({
      text: 'Too many attempts. Wait a minute and try again.',
    });
    expect(describeErrorHint(new Error('boom'))).toEqual({
      text: 'Could not reach the server.',
    });
  });

  test('a forbidden error links back to the Overview', () => {
    const error = new ApiError(403, AUTH_ERROR.forbidden, 'Forbidden');
    expect(describeErrorHint(error)).toEqual({
      text: 'You do not have access to this.',
      href: '/',
      cta: 'Go to Overview',
    });
  });
});

describe('surviving an API restart (spec 353)', () => {
  const realFetch = globalThis.fetch;
  const realSleep = apiRuntime.sleep;
  const realDocument = (globalThis as { document?: unknown }).document;
  let sleeps: number[] = [];

  beforeEach(() => {
    sleeps = [];
    apiRuntime.sleep = async (ms) => {
      sleeps.push(ms);
    };
    (globalThis as { document?: unknown }).document = { cookie: '' };
    reachability.markReachable();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    apiRuntime.sleep = realSleep;
    (globalThis as { document?: unknown }).document = realDocument;
    reachability.markReachable();
  });

  /** A fetch double answering from a script, one entry per call. */
  const script = (...steps: (Response | Error)[]) => {
    const calls: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls.push(init?.method ?? 'GET');
      const step = steps[Math.min(calls.length, steps.length) - 1];
      if (step instanceof Error) throw step;
      return step?.clone();
    }) as unknown as typeof fetch;
    return calls;
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });

  test('a board GET is retried through a 502 and a network error until it answers', async () => {
    const calls = script(
      new Response('bad gateway', { status: 502 }),
      new TypeError('fetch failed'),
      json({ columns: [] }),
    );
    expect(await api<{ columns: unknown[] }>('/projects/p/board')).toEqual({
      columns: [],
    });
    expect(calls).toEqual(['GET', 'GET', 'GET']);
    expect(sleeps).toEqual([500, 1_000]);
    expect(reachability.isUnreachable()).toBe(false);
  });

  test('retries back off 0.5, 1, 2, 4, 8 s and stop inside 30 s', async () => {
    const calls = script(new Response('down', { status: 503 }));
    const error = await api('/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiUnreachableError);
    expect((error as ApiUnreachableError).message).toBe(
      RESTARTING_READ_MESSAGE,
    );
    expect(sleeps.slice(0, 5)).toEqual([500, 1_000, 2_000, 4_000, 8_000]);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(30_000);
    expect(calls).toHaveLength(sleeps.length + 1);
    expect(reachability.isUnreachable()).toBe(true);
  });

  test('a DELETE during the outage is not retried and says nothing was changed', async () => {
    const calls = script(new Response('bad gateway', { status: 502 }));
    const error = await api('/projects/p/board/cards/7', {
      method: 'DELETE',
    }).catch((e: unknown) => e);
    expect(calls).toEqual(['DELETE']);
    expect(sleeps).toEqual([]);
    expect(error).toBeInstanceOf(ApiUnreachableError);
    expect(describeError(error)).toBe(
      'Nautelle was restarting — nothing was changed. Try again',
    );
  });

  test('a write that fails with a network error gets the same sentence', async () => {
    const calls = script(new TypeError('fetch failed'));
    const error = await api('/x', { method: 'POST', body: { a: 1 } }).catch(
      (e: unknown) => e,
    );
    expect(calls).toEqual(['POST']);
    expect((error as Error).message).toBe(RESTARTING_WRITE_MESSAGE);
  });

  test('the first success clears the unreachable state', async () => {
    script(new Response('down', { status: 504 }));
    await api('/x', { method: 'PATCH', body: {} }).catch(() => {});
    expect(reachability.isUnreachable()).toBe(true);
    script(json({ ok: true }));
    await api('/y');
    expect(reachability.isUnreachable()).toBe(false);
  });

  test('a real 404 still reads as not found and is not retried', async () => {
    const calls = script(
      json({ error: AUTH_ERROR.notFound, message: 'Not Found' }, 404),
    );
    const error = await api('/projects/p/board/cards/999').catch(
      (e: unknown) => e,
    );
    expect(calls).toEqual(['GET']);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(ApiUnreachableError);
    expect(describeError(error)).toBe('It no longer exists. Refresh the list.');
    expect(sleeps).toEqual([]);
    expect(reachability.isUnreachable()).toBe(false);
  });

  test('a malformed csrf cookie does not throw and the write goes out without it', async () => {
    (globalThis as { document?: unknown }).document = {
      cookie: 'other=1; ad_csrf=%E0%A4%A',
    };
    const headers: (HeadersInit | undefined)[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      headers.push(init?.headers);
      return json({});
    }) as unknown as typeof fetch;
    await api('/x', { method: 'POST', body: {} });
    expect(headers).toHaveLength(1);
    expect(JSON.stringify(headers[0])).not.toContain('x-csrf-token');
  });

  test('other 5xx answers are the server’s, not an outage', async () => {
    const calls = script(json({ message: 'boom' }, 500));
    const error = await api('/x').catch((e: unknown) => e);
    expect(calls).toEqual(['GET']);
    expect((error as ApiError).status).toBe(500);
    expect(error).not.toBeInstanceOf(ApiUnreachableError);
  });
});

describe('refusing a path that leaves its route (C-165)', () => {
  const realFetch = globalThis.fetch;
  let calls: string[] = [];

  beforeEach(() => {
    calls = [];
    globalThis.fetch = (async (url: unknown) => {
      calls.push(String(url));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('an encoded ../ in an id throws before fetch is called', async () => {
    const error = await api('/projects/x/plans/a%2F..%2Fb', {
      method: 'POST',
      body: {},
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsafeApiPathError);
    expect(describeError(error)).toBe(UNSAFE_PATH_MESSAGE);
    expect(calls).toEqual([]);
  });

  test.each([
    '/projects/x/plans/../budgets',
    '/projects/x/plans/..',
    '/projects/x/./plans',
    '/projects/x\\plans',
    '/projects/x/plans/%2e%2e',
    '/projects/x/plans/a%5Cb',
    'projects/x',
  ])('%s is refused', async (path) => {
    expect(isSafeApiPath(path)).toBe(false);
    await expect(api(path)).rejects.toBeInstanceOf(UnsafeApiPathError);
    expect(calls).toEqual([]);
  });

  test('an ordinary path, and encoded slashes in the query, go out', async () => {
    expect(isSafeApiPath('/projects/c1/plans/c2/tasks/t1.2')).toBe(true);
    await api('/projects/c1/board/captures?cursor=a%2Fb..');
    expect(calls).toEqual(['/api/projects/c1/board/captures?cursor=a%2Fb..']);
  });
});
