import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  checkWebhookTarget,
  guardedPost,
  type HostResolver,
  isBlockedAddress,
  isValidAllowlistEntry,
  type ResolvedAddress,
  TargetAllowlist,
} from './ssrf-guard';

const PUBLIC = '93.184.215.14';
const none = new TargetAllowlist([]);

/** A resolver answering from a table, counting its calls. */
const fakeResolver = (table: Record<string, string[]>) => {
  const calls: string[] = [];
  const resolve: HostResolver = async (host) => {
    calls.push(host);
    const addresses = table[host];
    if (!addresses) throw new Error('ENOTFOUND');
    return addresses.map(
      (address): ResolvedAddress => ({
        address,
        family: address.includes(':') ? 6 : 4,
      }),
    );
  };
  return { resolve, calls };
};

describe('isBlockedAddress (D15)', () => {
  it.each([
    ['127.0.0.1'],
    ['10.0.0.5'],
    ['169.254.169.254'],
    ['100.100.1.1'],
    ['172.16.0.1'],
    ['192.168.1.10'],
    ['0.0.0.0'],
    ['224.0.0.1'],
    ['255.255.255.255'],
    ['::1'],
    ['::'],
    ['::ffff:127.0.0.1'],
    ['::ffff:10.0.0.5'],
    ['fd00::1'],
    ['fe80::1'],
    ['64:ff9b::a00:5'],
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    [PUBLIC],
    ['1.1.1.1'],
    ['2606:4700:4700::1111'],
    ['172.32.0.1'],
  ])('lets %s through', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe('checkWebhookTarget (D15)', () => {
  it.each([
    ['https://127.0.0.1/hook'],
    ['https://10.0.0.5/hook'],
    ['https://169.254.169.254/latest/meta-data'],
    ['https://100.100.1.1/hook'],
    ['https://[::1]/hook'],
    ['https://[::ffff:127.0.0.1]/hook'],
  ])('refuses %s with blocked_address', async (url) => {
    await expect(checkWebhookTarget(url, none)).resolves.toMatchObject({
      ok: false,
      error: 'blocked_address',
    });
  });

  it('refuses a name when any of its addresses is private', async () => {
    const { resolve } = fakeResolver({ 'mixed.example': [PUBLIC, '10.0.0.5'] });
    await expect(
      checkWebhookTarget('https://mixed.example/hook', none, resolve),
    ).resolves.toEqual({
      ok: false,
      error: 'blocked_address',
      address: '10.0.0.5',
    });
  });

  it('accepts https to a public name', async () => {
    const { resolve } = fakeResolver({ 'hooks.example': [PUBLIC] });
    const check = await checkWebhookTarget(
      'https://hooks.example/n8n',
      none,
      resolve,
    );
    expect(check).toMatchObject({
      ok: true,
      host: 'hooks.example',
      connectTo: { address: PUBLIC, family: 4 },
    });
  });

  it('requires https unless the host is allowlisted', async () => {
    const { resolve } = fakeResolver({ 'hooks.example': [PUBLIC] });
    await expect(
      checkWebhookTarget('http://hooks.example/n8n', none, resolve),
    ).resolves.toEqual({ ok: false, error: 'https_required' });
    await expect(
      checkWebhookTarget(
        'http://hooks.example/n8n',
        new TargetAllowlist(['hooks.example']),
        resolve,
      ),
    ).resolves.toMatchObject({ ok: true });
  });

  it('allows a private host by name or by CIDR', async () => {
    const { resolve } = fakeResolver({ 'n8n.lan': ['192.168.1.20'] });
    await expect(
      checkWebhookTarget('http://n8n.lan/hook', none, resolve),
    ).resolves.toMatchObject({ ok: false, error: 'blocked_address' });
    await expect(
      checkWebhookTarget(
        'http://n8n.lan/hook',
        new TargetAllowlist(['N8N.lan']),
        resolve,
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      checkWebhookTarget(
        'http://n8n.lan/hook',
        new TargetAllowlist(['192.168.1.0/24']),
        resolve,
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      checkWebhookTarget(
        'http://n8n.lan/hook',
        new TargetAllowlist(['192.168.2.0/24']),
        resolve,
      ),
    ).resolves.toMatchObject({ ok: false, error: 'blocked_address' });
  });

  it('re-checks at send time: a name that turned private is refused', async () => {
    let answer = PUBLIC;
    const resolve: HostResolver = async () => [{ address: answer, family: 4 }];
    await expect(
      checkWebhookTarget('https://rebind.example/hook', none, resolve),
    ).resolves.toMatchObject({ ok: true });
    answer = '127.0.0.1';
    await expect(
      checkWebhookTarget('https://rebind.example/hook', none, resolve),
    ).resolves.toMatchObject({ ok: false, error: 'blocked_address' });
  });

  it.each([
    ['not a url'],
    ['ftp://hooks.example/x'],
    ['file:///etc/passwd'],
    ['https://user:pass@hooks.example/x'],
  ])('refuses %p as invalid_url', async (url) => {
    await expect(checkWebhookTarget(url, none)).resolves.toMatchObject({
      ok: false,
      error: 'invalid_url',
    });
  });

  it('reports a name that does not resolve', async () => {
    const { resolve } = fakeResolver({});
    await expect(
      checkWebhookTarget('https://nowhere.example/x', none, resolve),
    ).resolves.toEqual({ ok: false, error: 'unresolvable' });
  });
});

describe('isValidAllowlistEntry', () => {
  it('reads hosts, addresses and CIDRs', () => {
    expect(isValidAllowlistEntry('n8n.lan')).toBe(true);
    expect(isValidAllowlistEntry('10.0.0.0/8')).toBe(true);
    expect(isValidAllowlistEntry('fd00::/8')).toBe(true);
    expect(isValidAllowlistEntry('10.0.0.0/33')).toBe(false);
    expect(isValidAllowlistEntry('n8n.lan/24')).toBe(false);
  });
});

describe('guardedPost (D12, D15)', () => {
  type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
  let server: http.Server;
  let port: number;
  let handler: Handler;
  const hits: { url: string; host: string | undefined; body: string }[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        hits.push({ url: req.url ?? '', host: req.headers.host, body });
        handler(req, res);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    hits.length = 0;
    handler = (_req, res) => res.writeHead(204).end();
  });

  const lan = () => fakeResolver({ 'n8n.lan': ['127.0.0.1'] });
  const post = (
    url: string,
    allowlist: TargetAllowlist,
    resolve: HostResolver,
    extra: { timeoutMs?: number } = {},
  ) =>
    guardedPost({
      url,
      body: '{"type":"webhook.test"}',
      headers: { 'X-AgentDock-Event': 'webhook.test' },
      allowlist,
      resolve,
      ...extra,
    });

  it('delivers to an allowlisted private host, connecting to the checked address once', async () => {
    const { resolve, calls } = lan();
    const result = await post(
      `http://n8n.lan:${port}/hook`,
      new TargetAllowlist(['n8n.lan']),
      resolve,
    );
    expect(result).toEqual({
      succeeded: true,
      status: 204,
      body: '',
      error: null,
    });
    expect(calls).toEqual(['n8n.lan']);
    expect(hits).toEqual([
      {
        url: '/hook',
        host: `n8n.lan:${port}`,
        body: '{"type":"webhook.test"}',
      },
    ]);
  });

  it('refuses the same host without the allowlist and sends nothing', async () => {
    const { resolve } = lan();
    const result = await post(`http://n8n.lan:${port}/hook`, none, resolve);
    expect(result).toMatchObject({
      succeeded: false,
      error: 'blocked_address',
      address: '127.0.0.1',
    });
    expect(hits).toEqual([]);
  });

  it('records a 302 as a failure and does not follow it', async () => {
    handler = (req, res) => {
      if (req.url === '/hook') {
        res
          .writeHead(302, { Location: `http://127.0.0.1:${port}/followed` })
          .end();
      } else res.writeHead(200).end('followed');
    };
    const { resolve } = lan();
    const result = await post(
      `http://n8n.lan:${port}/hook`,
      new TargetAllowlist(['n8n.lan']),
      resolve,
    );
    expect(result).toMatchObject({
      succeeded: false,
      status: 302,
      error: 'redirect',
    });
    expect(hits.map((hit) => hit.url)).toEqual(['/hook']);
  });

  it('records a 500 and keeps at most 2 KB of its body', async () => {
    handler = (_req, res) => res.writeHead(500).end('x'.repeat(10_000));
    const { resolve } = lan();
    const result = await post(
      `http://n8n.lan:${port}/hook`,
      new TargetAllowlist(['n8n.lan']),
      resolve,
    );
    expect(result).toMatchObject({
      succeeded: false,
      status: 500,
      error: 'http_status',
    });
    expect(result.body).toHaveLength(2048);
  });

  it('gives up after the timeout', async () => {
    handler = () => undefined;
    const { resolve } = lan();
    const result = await post(
      `http://n8n.lan:${port}/hook`,
      new TargetAllowlist(['n8n.lan']),
      resolve,
      { timeoutMs: 200 },
    );
    expect(result).toEqual({
      succeeded: false,
      status: null,
      body: null,
      error: 'timeout',
    });
  });

  it('reports a refused connection as network_error', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, '127.0.0.1', resolve),
    );
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const { resolve } = lan();
    const result = await post(
      `http://n8n.lan:${closedPort}/hook`,
      new TargetAllowlist(['n8n.lan']),
      resolve,
    );
    expect(result).toMatchObject({ succeeded: false, error: 'network_error' });
  });
});
