import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  parseRawJson,
  type RawBodyRequest,
  rawBodyMiddleware,
} from './raw-body';

/** A server running the middleware, then answering what it captured. */
const startServer = async (maxBytes = 64) => {
  const middleware = rawBodyMiddleware(['/hooks'], maxBytes);
  const server = http.createServer((req: RawBodyRequest, res) => {
    middleware(req, res, (error) => {
      if (error) {
        res.writeHead(500).end();
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          raw:
            req.rawBody === undefined ? null : req.rawBody.toString('base64'),
          readableEnded: req.readableEnded,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
};

const send = (
  port: number,
  path: string,
  body: string | Buffer,
  headers: Record<string, string> = { 'Content-Type': 'application/json' },
  method = 'POST',
) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : body,
  });

describe('rawBodyMiddleware (D8)', () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    ctx = await startServer();
  });

  afterAll(async () => {
    ctx.server.closeAllConnections();
    await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
  });

  it('captures the exact bytes on a hook route and consumes the stream', async () => {
    const body = Buffer.from('{ "b" : 1,\n"a":"é" }');
    const res = await send(ctx.port, '/hooks/abc', body);
    const json = (await res.json()) as { raw: string; readableEnded: boolean };
    expect(Buffer.from(json.raw, 'base64').equals(body)).toBe(true);
    // Nest's parsers skip a finished request, so the body stays unparsed.
    expect(json.readableEnded).toBe(true);
  });

  it('accepts a charset parameter', async () => {
    const res = await send(ctx.port, '/hooks/abc?x=1', '{}', {
      'Content-Type': 'application/json; charset=utf-8',
    });
    expect(((await res.json()) as { raw: string }).raw).toBe(
      Buffer.from('{}').toString('base64'),
    );
  });

  it('leaves every other route, method and content type alone', async () => {
    for (const [path, headers, method] of [
      ['/auth/login', { 'Content-Type': 'application/json' }, 'POST'],
      ['/hooksmith', { 'Content-Type': 'application/json' }, 'POST'],
      ['/hooks/abc', { 'Content-Type': 'text/plain' }, 'POST'],
      ['/hooks/abc', {}, 'GET'],
    ] as const) {
      const res = await send(ctx.port, path, '{}', { ...headers }, method);
      expect(((await res.json()) as { raw: string | null }).raw).toBeNull();
    }
  });

  it('answers 413 above the limit, declared or streamed', async () => {
    const res = await send(ctx.port, '/hooks/abc', 'x'.repeat(65));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'payload_too_large' });

    const exact = await send(ctx.port, '/hooks/abc', 'x'.repeat(64));
    expect(exact.status).toBe(200);

    // Chunked, no Content-Length: the limit is enforced while reading.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: ctx.port,
          path: '/hooks/abc',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.write('x'.repeat(40));
      req.end('x'.repeat(40));
    });
    expect(status).toBe(413);
  });

  it('answers 415 to a compressed body', async () => {
    const res = await send(ctx.port, '/hooks/abc', '{}', {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
    });
    expect(res.status).toBe(415);
  });
});

describe('parseRawJson', () => {
  it('parses JSON and refuses anything else', () => {
    expect(parseRawJson(Buffer.from('{"a":[1]}'))).toEqual({
      ok: true,
      value: { a: [1] },
    });
    expect(parseRawJson(Buffer.from('{oops'))).toEqual({ ok: false });
    expect(parseRawJson(Buffer.alloc(0))).toEqual({ ok: false });
    expect(parseRawJson(undefined)).toEqual({ ok: false });
  });
});
