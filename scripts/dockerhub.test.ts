import { describe, expect, test } from 'bun:test';
import {
  absoluteLinks,
  fullDescription,
  readSettings,
  repositories,
  syncRepositories,
} from './dockerhub';

const FILE = 'DOCKERHUB_NAMESPACE=abegma\nDOCKERHUB_REPO_PREFIX=nautelle-\n';
const settings = { namespace: 'abegma', prefix: 'nautelle-' };

describe('readSettings', () => {
  test('reads the file, the environment wins, an empty prefix stays empty', () => {
    expect(readSettings(FILE, {})).toEqual(settings);
    expect(
      readSettings(FILE, {
        DOCKERHUB_NAMESPACE: 'nautelle',
        DOCKERHUB_REPO_PREFIX: '',
      }),
    ).toEqual({ namespace: 'nautelle', prefix: '' });
  });

  test('refuses a missing or malformed namespace', () => {
    expect(() => readSettings('', {})).toThrow('not a namespace');
    expect(() => readSettings(FILE, { DOCKERHUB_NAMESPACE: 'A/b' })).toThrow(
      'not a namespace',
    );
  });
});

describe('repositories', () => {
  test('names the API and web with the prefix, the all-in-one without', () => {
    expect(repositories(settings).map((repo) => repo.name)).toEqual([
      'nautelle-api',
      'nautelle-web',
      'nautelle',
    ]);
    for (const repo of repositories(settings)) {
      expect(repo.description.length).toBeLessThanOrEqual(100);
    }
  });
});

describe('absoluteLinks', () => {
  test('makes relative links and images absolute, leaves the rest', () => {
    const readme = [
      '[Install](docs/install.md) [site](https://x.dev) [top](#quick-start)',
      '![logo](./assets/logo.svg)',
      '<img src="assets/a.png"> <source srcset="https://x.dev/b.png">',
      '<a href="LICENSE">license</a>',
    ].join('\n');
    expect(absoluteLinks(readme)).toBe(
      [
        '[Install](https://github.com/AndreyBegma/Nautelle/blob/main/docs/install.md) [site](https://x.dev) [top](#quick-start)',
        '![logo](https://raw.githubusercontent.com/AndreyBegma/Nautelle/main/assets/logo.svg)',
        '<img src="https://raw.githubusercontent.com/AndreyBegma/Nautelle/main/assets/a.png"> <source srcset="https://x.dev/b.png">',
        '<a href="https://github.com/AndreyBegma/Nautelle/blob/main/LICENSE">license</a>',
      ].join('\n'),
    );
  });
});

describe('fullDescription', () => {
  const [api, , allInOne] = repositories(settings);

  test('heads the README with the image, and the all-in-one with a try-out', () => {
    expect(fullDescription('# Nautelle', api as never, settings)).toContain(
      '**docker.io/abegma/nautelle-api** is the same image as `ghcr.io/andreybegma/nautelle-api`',
    );
    expect(
      fullDescription('# Nautelle', allInOne as never, settings),
    ).toContain('docker run -p 8000:8000 -v nautelle:/data abegma/nautelle');
  });

  test("stays within Docker Hub's 25 000 characters", () => {
    const text = fullDescription('x'.repeat(30_000), api as never, settings);
    expect(text.length).toBe(25_000);
    expect(text).toEndWith('#readme).\n');
  });
});

describe('syncRepositories', () => {
  type Call = { method: string; url: string; body: unknown };

  const hub = (answer: (call: Call) => Response) => {
    const calls: Call[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      const call = {
        method: init?.method ?? 'GET',
        url,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      };
      calls.push(call);
      return answer(call);
    };
    return { calls, fetch };
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });
  const run = (fetch: ReturnType<typeof hub>['fetch']) =>
    syncRepositories({
      settings,
      readme: '# Nautelle',
      username: 'abegma',
      token: 'dckr_pat_test',
      fetch,
      log: () => {},
    });

  test('creates the missing repositories as public, then describes all', async () => {
    const { calls, fetch } = hub((call) => {
      if (call.url.endsWith('/v2/auth/token')) {
        return json({ access_token: 'jwt' });
      }
      if (call.method === 'GET') {
        return call.url.includes('/nautelle-api/')
          ? json({ is_private: false })
          : json({}, 404);
      }
      return json({}, call.method === 'POST' ? 201 : 200);
    });
    await run(fetch);
    expect(calls[0]?.body).toEqual({
      identifier: 'abegma',
      secret: 'dckr_pat_test',
    });
    const created = calls.filter(
      (call) =>
        call.method === 'POST' && call.url.endsWith('/v2/repositories/'),
    );
    expect(created.map((call) => call.body)).toMatchObject([
      { namespace: 'abegma', name: 'nautelle-web', is_private: false },
      { namespace: 'abegma', name: 'nautelle', is_private: false },
    ]);
    expect(
      calls
        .filter((call) => call.method === 'PATCH')
        .map((call) => call.url.replace('https://hub.docker.com', '')),
    ).toEqual([
      '/v2/repositories/abegma/nautelle-api/',
      '/v2/repositories/abegma/nautelle-web/',
      '/v2/repositories/abegma/nautelle/',
    ]);
  });

  test('fails on a refused sign-in, a private repository or a refused write', async () => {
    await expect(
      run(hub(() => json({ detail: 'nope' }, 401)).fetch),
    ).rejects.toThrow('signing in as abegma: Docker Hub answered 401');

    const signedIn = (rest: (call: Call) => Response) => (call: Call) =>
      call.url.endsWith('/v2/auth/token')
        ? json({ access_token: 'jwt' })
        : rest(call);
    await expect(
      run(hub(signedIn(() => json({ is_private: true }))).fetch),
    ).rejects.toThrow('abegma/nautelle-api is private');
    await expect(
      run(
        hub(
          signedIn((call) =>
            call.method === 'GET' ? json({}, 404) : json({}, 403),
          ),
        ).fetch,
      ),
    ).rejects.toThrow('creating abegma/nautelle-api: Docker Hub answered 403');
  });
});
