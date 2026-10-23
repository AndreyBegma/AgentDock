import { generateKeyPairSync } from 'node:crypto';
import type { GitHubAppOptions } from './github-app-options';
import { GitHubAppClient } from './github-client';

describe('GitHubAppClient installation token (C-145)', () => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;

  const setup = () => {
    const requests: { method: string; path: string; body: unknown }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      requests.push({
        method: init?.method ?? 'GET',
        path: url.pathname,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      const body = url.pathname.endsWith('/access_tokens')
        ? { token: 'ghs_scoped' }
        : { total_count: 1, repositories: [{ id: 7, full_name: 'Acme/Repo' }] };
      return new Response(JSON.stringify(body), {
        status: url.pathname.endsWith('/access_tokens') ? 201 : 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const options: GitHubAppOptions = {
      publicUrl: 'https://dock.example',
      appUrl: 'http://web.test',
      apiBase: 'http://github.test',
      debounceMs: 300,
      resyncWindowMs: 60_000,
      healthIntervalMs: 60_000,
      autoStart: false,
      requestTimeoutMs: 2_000,
      fetch,
    };
    return { requests, client: new GitHubAppClient(options) };
  };

  it('asks for an explicit, read-only permissions object, never the App’s full set', async () => {
    const { requests, client } = setup();
    const repos = await client.listInstallationRepos(4242, key, 77);
    expect(repos).toEqual([{ repoId: 7n, fullName: 'acme/repo' }]);
    const token = requests.find((r) =>
      r.path.endsWith('/app/installations/77/access_tokens'),
    );
    expect(token).toEqual({
      method: 'POST',
      path: '/app/installations/77/access_tokens',
      body: { permissions: { metadata: 'read' } },
    });
  });

  it('sends no body on a GET', async () => {
    const { requests, client } = setup();
    await client.listInstallationRepos(4242, key, 77);
    const list = requests.find((r) => r.method === 'GET');
    expect(list?.body).toBeNull();
  });
});
