import { afterEach, describe, expect, it } from 'bun:test';
import { gzipSync } from 'node:zlib';
import type { UnsequencedEvent } from '@agentdock/shared/protocol';
import { createLogger } from '../log';
import {
  handleOtlpRequest,
  isLoopback,
  MAX_BODY_BYTES,
  OtlpReceiver,
  type ReceiverDeps,
} from './receiver';
import { FORBIDDEN, fixtureJson, fixtureProtobuf } from './testing';

const silent = createLogger({ level: 'error', write: () => {} });

const deps = (
  emitted: UnsequencedEvent[],
  overrides: Partial<ReceiverDeps> = {},
): ReceiverDeps => ({
  emit: (event) => emitted.push(event),
  projects: async () => new Map(),
  codexExperimental: false,
  now: () => '2026-10-08T00:00:00.000Z',
  log: silent,
  ...overrides,
});

const post = (
  path: string,
  body: Uint8Array | string,
  headers: Record<string, string> = {},
): Request =>
  new Request(`http://127.0.0.1:4318${path}`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/x-protobuf', ...headers },
  });

const LOCAL = '127.0.0.1';

describe('otlp receiver — handler (D11, D16)', () => {
  it('accepts a protobuf export and answers an empty protobuf response', async () => {
    const emitted: UnsequencedEvent[] = [];
    const response = await handleOtlpRequest(
      post('/v1/logs', fixtureProtobuf()),
      LOCAL,
      deps(emitted),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-protobuf');
    expect((await response.arrayBuffer()).byteLength).toBe(0);
    expect(emitted).toHaveLength(2);
    expect(emitted.every((e) => e.type === 'llm.request')).toBe(true);
  });

  it('accepts a JSON export, with a charset, and answers {}', async () => {
    const emitted: UnsequencedEvent[] = [];
    const response = await handleOtlpRequest(
      post('/v1/logs', fixtureJson(), {
        'content-type': 'application/json; charset=utf-8',
      }),
      '::1',
      deps(emitted),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{}');
    expect(emitted).toHaveLength(2);
  });

  it('accepts a gzip-compressed export', async () => {
    const emitted: UnsequencedEvent[] = [];
    const response = await handleOtlpRequest(
      post('/v1/logs', gzipSync(fixtureProtobuf()), {
        'content-encoding': 'gzip',
      }),
      LOCAL,
      deps(emitted),
    );
    expect(response.status).toBe(200);
    expect(emitted).toHaveLength(2);
  });

  it('refuses a non-loopback peer before reading anything', async () => {
    const emitted: UnsequencedEvent[] = [];
    for (const peer of ['192.168.1.5', '10.0.0.1', '::ffff:10.0.0.1', null]) {
      const response = await handleOtlpRequest(
        post('/v1/logs', fixtureProtobuf()),
        peer,
        deps(emitted),
      );
      expect(response.status).toBe(403);
    }
    expect(emitted).toEqual([]);
  });

  it('refuses a body over 4 MiB: declared, streamed, and inflated', async () => {
    const emitted: UnsequencedEvent[] = [];
    const big = new Uint8Array(MAX_BODY_BYTES + 1);
    const declared = await handleOtlpRequest(
      post('/v1/logs', big),
      LOCAL,
      deps(emitted),
    );
    expect(declared.status).toBe(413);

    // A chunked body has no Content-Length: the cap is counted while reading.
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_BODY_BYTES) return controller.close();
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const streamed = await handleOtlpRequest(
      new Request('http://127.0.0.1:4318/v1/logs', {
        method: 'POST',
        body: stream,
        headers: { 'content-type': 'application/x-protobuf' },
      }),
      LOCAL,
      deps(emitted),
    );
    expect(streamed.status).toBe(413);

    // 5 MiB of zeros gzip to a few KiB: the inflated size is what counts.
    const bomb = gzipSync(new Uint8Array(5 * 1024 * 1024));
    expect(bomb.byteLength).toBeLessThan(MAX_BODY_BYTES);
    const inflated = await handleOtlpRequest(
      post('/v1/logs', bomb, { 'content-encoding': 'gzip' }),
      LOCAL,
      deps(emitted),
    );
    expect(inflated.status).toBe(413);
    expect(emitted).toEqual([]);
  });

  it('accepts a body of exactly 4 MiB', async () => {
    // Zero bytes are not a valid request, so this ends at decoding, not at the cap.
    const response = await handleOtlpRequest(
      post('/v1/logs', new Uint8Array(MAX_BODY_BYTES)),
      LOCAL,
      deps([]),
    );
    expect(response.status).not.toBe(413);
  });

  it('answers 415 for another content type or encoding, 400 for a bad body', async () => {
    const d = deps([]);
    const text = await handleOtlpRequest(
      post('/v1/logs', 'x', { 'content-type': 'text/plain' }),
      LOCAL,
      d,
    );
    expect(text.status).toBe(415);
    const brotli = await handleOtlpRequest(
      post('/v1/logs', 'x', { 'content-encoding': 'br' }),
      LOCAL,
      d,
    );
    expect(brotli.status).toBe(415);
    const garbage = await handleOtlpRequest(
      post('/v1/logs', new Uint8Array([0x0a, 0xff, 0xff])),
      LOCAL,
      d,
    );
    expect(garbage.status).toBe(400);
    const badJson = await handleOtlpRequest(
      post('/v1/logs', '{nope', { 'content-type': 'application/json' }),
      LOCAL,
      d,
    );
    expect(badJson.status).toBe(400);
    const badGzip = await handleOtlpRequest(
      post('/v1/logs', 'not gzip', { 'content-encoding': 'gzip' }),
      LOCAL,
      d,
    );
    expect(badGzip.status).toBe(400);
  });

  it('accepts and discards metrics and traces; 404 and 405 elsewhere', async () => {
    const emitted: UnsequencedEvent[] = [];
    for (const path of ['/v1/metrics', '/v1/traces']) {
      const response = await handleOtlpRequest(
        post(path, fixtureProtobuf()),
        LOCAL,
        deps(emitted),
      );
      expect(response.status).toBe(200);
    }
    expect(emitted).toEqual([]);
    const other = await handleOtlpRequest(
      post('/v1/profiles', ''),
      LOCAL,
      deps(emitted),
    );
    expect(other.status).toBe(404);
    const get = await handleOtlpRequest(
      new Request('http://127.0.0.1:4318/v1/logs'),
      LOCAL,
      deps(emitted),
    );
    expect(get.status).toBe(405);
  });

  it('answers 503 when the spool cannot take the events, so the exporter retries', async () => {
    const response = await handleOtlpRequest(
      post('/v1/logs', fixtureProtobuf()),
      LOCAL,
      deps([], {
        emit: () => {
          throw new Error('disk full');
        },
      }),
    );
    expect(response.status).toBe(503);
  });

  it('resolves the agentdock.project ids of the request for the envelope (D14)', async () => {
    const emitted: UnsequencedEvent[] = [];
    const asked: string[][] = [];
    await handleOtlpRequest(
      post('/v1/logs', fixtureProtobuf()),
      LOCAL,
      deps(emitted, {
        projects: async (ids) => {
          asked.push([...ids]);
          return new Map([
            ['prj_fixture', { repo: 'AndreyBegma/fixture', root: '/r' }],
          ]);
        },
      }),
    );
    expect(asked).toEqual([['prj_fixture']]);
    expect(emitted[0]?.project).toEqual({
      repo: 'AndreyBegma/fixture',
      root: '/r',
    });
  });

  it('classifies loopback addresses', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
      expect(isLoopback(a)).toBe(true);
    }
    for (const a of ['0.0.0.0', '192.168.0.1', '::ffff:8.8.8.8', '', null]) {
      expect(isLoopback(a)).toBe(false);
    }
  });
});

describe('otlp receiver — server', () => {
  let receiver: OtlpReceiver | null = null;
  afterEach(async () => {
    await receiver?.stop();
    receiver = null;
  });

  it('listens on 127.0.0.1 and turns a real export into events', async () => {
    const emitted: UnsequencedEvent[] = [];
    receiver = new OtlpReceiver({ ...deps(emitted), port: 0 });
    const port = receiver.start();
    expect(port).toBeGreaterThan(0);
    expect(receiver.port).toBe(port);

    const pb = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: 'POST',
      body: fixtureProtobuf(),
      headers: { 'content-type': 'application/x-protobuf' },
    });
    expect(pb.status).toBe(200);
    const json = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: 'POST',
      body: fixtureJson(),
      headers: { 'content-type': 'application/json' },
    });
    expect(json.status).toBe(200);
    expect(emitted).toHaveLength(4);
    const sent = JSON.stringify(emitted);
    for (const value of FORBIDDEN) expect(sent).not.toContain(value);
  });

  it('refuses a body over 4 MiB on the wire', async () => {
    const emitted: UnsequencedEvent[] = [];
    receiver = new OtlpReceiver({ ...deps(emitted), port: 0 });
    const port = receiver.start();
    const response = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: 'POST',
      body: new Uint8Array(MAX_BODY_BYTES + 1),
      headers: { 'content-type': 'application/x-protobuf' },
    });
    expect(response.status).toBe(413);
    expect(emitted).toEqual([]);
  });

  it('cannot bind a port that is taken', async () => {
    receiver = new OtlpReceiver({ ...deps([]), port: 0 });
    const port = receiver.start();
    const second = new OtlpReceiver({ ...deps([]), port });
    expect(() => second.start()).toThrow();
  });
});
