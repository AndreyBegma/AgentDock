import { describe, expect, test } from 'bun:test';
import type { LiveEventMessage } from '@agentdock/shared';
import {
  BACKOFF_MAX_MS,
  backoffDelay,
  LiveClient,
  type LiveSocket,
  PING_INTERVAL_MS,
} from './client';

class FakeSocket implements LiveSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  sent: unknown[] = [];
  closed = false;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.();
  }
  drop(code: number) {
    this.onclose?.({ code });
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const timers: { id: number; fn: () => void; ms: number }[] = [];
  let nextId = 1;
  const client = new LiveClient({
    url: 'ws://test/live',
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    random: () => 0.5,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ id, fn, ms });
      return id;
    },
    clearTimer: (id) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  /** Fires the pending timer with the given delay. */
  const fire = (ms: number) => {
    const index = timers.findIndex((timer) => timer.ms === ms);
    expect(index).toBeGreaterThanOrEqual(0);
    const [timer] = timers.splice(index, 1);
    timer?.fn();
  };
  return { client, sockets, timers, fire };
}

const event = (topic: string, name = 'x'): LiveEventMessage => ({
  type: 'event',
  topic,
  event: name,
  data: { n: 1 },
  ts: '2026-10-07T00:00:00.000Z',
});

describe('backoffDelay', () => {
  test('doubles from 1 s and stops at 30 s', () => {
    const mid = () => 0.5;
    expect(backoffDelay(0, mid)).toBe(1_000);
    expect(backoffDelay(1, mid)).toBe(2_000);
    expect(backoffDelay(3, mid)).toBe(8_000);
    expect(backoffDelay(10, mid)).toBe(BACKOFF_MAX_MS);
  });

  test('jitter stays within ±20 %', () => {
    expect(backoffDelay(2, () => 0)).toBe(3_200);
    expect(backoffDelay(2, () => 1)).toBe(4_800);
  });
});

describe('LiveClient', () => {
  test('connects on first subscribe and subscribes once open', () => {
    const { client, sockets } = setup();
    client.subscribe('user:u1', () => {});
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.sent).toEqual([]);
    sockets[0]?.open();
    expect(client.getSnapshot().status).toBe('connected');
    expect(sockets[0]?.sent).toEqual([{ type: 'subscribe', topic: 'user:u1' }]);
  });

  test('delivers events to the handlers of that topic only', () => {
    const { client, sockets } = setup();
    const a: LiveEventMessage[] = [];
    const b: LiveEventMessage[] = [];
    client.subscribe('user:u1', (m) => a.push(m));
    client.subscribe('admin', (m) => b.push(m));
    sockets[0]?.open();
    sockets[0]?.receive(event('user:u1'));
    sockets[0]?.receive({ type: 'pong' });
    sockets[0]?.receive({ nonsense: true });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });

  test('shares one socket and one subscribe frame per topic', () => {
    const { client, sockets } = setup();
    client.subscribe('admin', () => {});
    client.subscribe('admin', () => {});
    sockets[0]?.open();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.sent).toEqual([{ type: 'subscribe', topic: 'admin' }]);
  });

  test('unsubscribes on the last handler and closes with the last topic', () => {
    const { client, sockets } = setup();
    const offA = client.subscribe('admin', () => {});
    const offB = client.subscribe('admin', () => {});
    sockets[0]?.open();
    offA();
    expect(sockets[0]?.sent).toHaveLength(1);
    offB();
    expect(sockets[0]?.sent.at(-1)).toEqual({
      type: 'unsubscribe',
      topic: 'admin',
    });
    expect(sockets[0]?.closed).toBe(true);
  });

  test('reconnects with backoff and resubscribes every topic', () => {
    const { client, sockets, fire } = setup();
    client.subscribe('user:u1', () => {});
    client.subscribe('admin', () => {});
    sockets[0]?.open();

    sockets[0]?.drop(1006);
    expect(client.getSnapshot().status).toBe('reconnecting');
    fire(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]?.drop(1006); // never opened: the next wait is longer
    fire(2_000);
    expect(sockets).toHaveLength(3);

    sockets[2]?.open();
    expect(client.getSnapshot().status).toBe('connected');
    expect(sockets[2]?.sent).toEqual([
      { type: 'subscribe', topic: 'user:u1' },
      { type: 'subscribe', topic: 'admin' },
    ]);

    // A successful open resets the backoff.
    sockets[2]?.drop(1001);
    fire(1_000);
    expect(sockets).toHaveLength(4);
  });

  test.each([4401, 4403, 4429])('does not reconnect after %d', (code) => {
    const { client, sockets, timers } = setup();
    client.subscribe('user:u1', () => {});
    sockets[0]?.open();
    sockets[0]?.drop(code);
    expect(client.getSnapshot()).toEqual({
      status: 'offline',
      closeCode: code,
    });
    expect(timers).toHaveLength(0);
    client.subscribe('admin', () => {});
    expect(sockets).toHaveLength(1);
  });

  test('pings while connected and stops after a drop', () => {
    const { client, sockets, timers, fire } = setup();
    client.subscribe('admin', () => {});
    sockets[0]?.open();
    fire(PING_INTERVAL_MS);
    expect(sockets[0]?.sent.at(-1)).toEqual({ type: 'ping' });
    sockets[0]?.drop(1006);
    expect(timers.some((timer) => timer.ms === PING_INTERVAL_MS)).toBe(false);
  });

  test('notifies listeners on status changes only', () => {
    const { client, sockets } = setup();
    let calls = 0;
    client.onChange(() => {
      calls += 1;
    });
    client.subscribe('admin', () => {});
    sockets[0]?.open();
    sockets[0]?.open();
    expect(calls).toBe(1);
  });
});
