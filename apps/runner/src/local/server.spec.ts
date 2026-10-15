import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { memoryLogger, tempDir } from '../testing/fixtures';
import { connectLocal, localRequest } from './client';
import { localSocketPath } from './paths';
import { type LocalHandler, LocalSocketServer } from './server';
import { LOCAL_LINE_MAX_BYTES } from './types';

describe('localSocketPath (spec 201 D5)', () => {
  it('uses $XDG_RUNTIME_DIR on Linux, the state dir otherwise', () => {
    expect(
      localSocketPath({ XDG_RUNTIME_DIR: '/run/user/1000' }, 'linux', '/s'),
    ).toBe('/run/user/1000/agentdock/runner.sock');
    expect(localSocketPath({}, 'linux', '/s')).toBe('/s/runner.sock');
    expect(localSocketPath({ XDG_RUNTIME_DIR: 'rel' }, 'linux', '/s')).toBe(
      '/s/runner.sock',
    );
    expect(
      localSocketPath({ XDG_RUNTIME_DIR: '/run/user/501' }, 'darwin', '/s'),
    ).toBe('/s/runner.sock');
  });
});

describe('LocalSocketServer + client', () => {
  let dir = '';
  let cleanup = () => {};
  let server: LocalSocketServer | null = null;

  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
  });
  afterEach(() => {
    server?.stop();
    server = null;
    cleanup();
  });

  const start = (
    handle: LocalHandler,
    path = join(dir, 'rt', 'runner.sock'),
  ) => {
    server = new LocalSocketServer({ path, handle, log: memoryLogger().log });
    server.start();
    return path;
  };

  const pong: LocalHandler = async (op, args) =>
    op === 'ping'
      ? {
          ok: true,
          data: { pong: true, online: true, awayMode: false, projectId: null },
        }
      : { ok: true, data: { op, args } };

  it('makes the directory 0700 and the socket 0600, replacing a stale socket file', async () => {
    const path = join(dir, 'rt', 'runner.sock');
    mkdirSync(join(dir, 'rt'), { recursive: true, mode: 0o755 });
    writeFileSync(path, 'stale');
    start(pong, path);
    expect(statSync(join(dir, 'rt')).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(path).isSocket()).toBe(true);
    const client = await connectLocal(path);
    expect(await client?.ping()).toEqual({
      ok: true,
      data: { pong: true, online: true, awayMode: false, projectId: null },
    });
    client?.close();
  });

  it('answers interleaved calls by id', async () => {
    const path = start(async (op, args) => {
      const delay = (args as { delay: number }).delay;
      await Bun.sleep(delay);
      return { ok: true, data: { op, delay } };
    });
    const client = await connectLocal(path);
    if (!client) throw new Error('no client');
    const [slow, fast] = await Promise.all([
      client.event({ delay: 30 } as never),
      client.event({ delay: 1 } as never),
    ]);
    expect(slow).toEqual({ ok: true, data: { op: 'event', delay: 30 } });
    expect(fast).toEqual({ ok: true, data: { op: 'event', delay: 1 } });
    client.close();
  });

  it('checks a request result against the method schema', async () => {
    const path = start(async () => ({ ok: true, data: { text: 'ctx' } }));
    expect(
      await localRequest(path, 'context.sessionStart', {}, { via: 'hook' }),
    ).toEqual({ ok: true, data: { text: 'ctx' } });
    expect(
      await localRequest(path, 'queue.list', { limit: 1 }, { via: 'mcp' }),
    ).toMatchObject({ ok: false, error: { code: 'internal' } });
  });

  it('passes the request context to the daemon', async () => {
    const seen: unknown[] = [];
    const path = start(async (_op, args) => {
      seen.push(args);
      return { ok: false, error: { code: 'no_project' } };
    });
    const result = await localRequest(
      path,
      'fleet.status',
      {},
      { via: 'mcp', cwd: '/w', ppid: 42 },
    );
    expect(result).toEqual({ ok: false, error: { code: 'no_project' } });
    expect(seen).toEqual([
      { method: 'fleet.status', args: {}, via: 'mcp', cwd: '/w', ppid: 42 },
    ]);
  });

  it('refuses a line over 256 KiB and closes the connection', async () => {
    const path = start(pong);
    const replies: string[] = [];
    const socket = await Bun.connect({
      unix: path,
      socket: {
        data: (_s, chunk) => {
          replies.push(chunk.toString());
        },
      },
    });
    let rest = Buffer.from('x'.repeat(LOCAL_LINE_MAX_BYTES + 10));
    while (rest.length > 0 && replies.length === 0) {
      const written = socket.write(rest);
      rest = rest.subarray(Math.max(0, written));
      await Bun.sleep(1);
    }
    const deadline = Date.now() + 2_000;
    while (replies.length === 0 && Date.now() < deadline) await Bun.sleep(5);
    expect(replies.join('')).toContain('line over 256 KiB');
    socket.end();
  });

  it('answers a malformed line with invalid_args and keeps the connection', async () => {
    const path = start(pong);
    const replies: string[] = [];
    const socket = await Bun.connect({
      unix: path,
      socket: {
        data: (_s, chunk) => {
          replies.push(chunk.toString());
        },
      },
    });
    socket.write('nope\n{"id":"a","op":"ping","args":{}}\n');
    const deadline = Date.now() + 2_000;
    while (replies.join('').split('\n').length < 3 && Date.now() < deadline) {
      await Bun.sleep(5);
    }
    const lines = replies.join('').trim().split('\n');
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      ok: false,
      error: { code: 'invalid_args' },
    });
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ id: 'a', ok: true });
    socket.end();
  });

  it('is daemon_unavailable within the connect timeout when nothing listens', async () => {
    const started = Date.now();
    expect(await connectLocal(join(dir, 'none.sock'))).toBeNull();
    expect(
      await localRequest(
        join(dir, 'none.sock'),
        'fleet.status',
        {},
        {
          via: 'mcp',
        },
      ),
    ).toMatchObject({ ok: false, error: { code: 'daemon_unavailable' } });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('turns a daemon that goes away mid-call into daemon_unavailable', async () => {
    const path = start(async () => {
      server?.stop();
      return new Promise(() => {});
    });
    const client = await connectLocal(path);
    expect(await client?.ping()).toMatchObject({
      ok: false,
      error: { code: 'daemon_unavailable' },
    });
  });
});
