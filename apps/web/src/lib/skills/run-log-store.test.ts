import { describe, expect, test } from 'bun:test';
import { type LiveTopic, runTopic } from '@nautelle/shared';
import {
  RUN_LOG_LIVE_EVENTS,
  type RunLogFrame,
} from '@nautelle/shared/protocol';
import { LiveClient, type LiveSocket } from '../live/client';
import { Reachability } from '../live/reachability';
import { RunLogRegistry } from './run-log-store';

class FakeSocket implements LiveSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  sent: { type: string; topic?: string }[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  drop(code: number) {
    this.onclose?.({ code });
  }
  push(topic: string, frame: RunLogFrame) {
    const event =
      frame.type === 'ended'
        ? RUN_LOG_LIVE_EVENTS.ended
        : RUN_LOG_LIVE_EVENTS.lines;
    this.onmessage?.({
      data: JSON.stringify({
        type: 'event',
        topic,
        event,
        data: frame,
        ts: '2026-10-16T00:00:00.000Z',
      }),
    });
  }
}

const lines = (backlog: boolean, ...texts: string[]): RunLogFrame => ({
  type: 'lines',
  backlog,
  lines: texts.map((text) => ({ kind: 'assistant' as const, text })),
});

function setup() {
  const sockets: FakeSocket[] = [];
  const timers: (() => void)[] = [];
  const client = new LiveClient({
    reachability: new Reachability({ setTimer: () => 0, clearTimer: () => {} }),
    url: 'ws://test/live',
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    random: () => 0.5,
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
  });
  const registry = new RunLogRegistry(client);
  const topic = runTopic('p_1', 'run_1') as LiveTopic;
  const texts = () => registry.getView(topic).log.rows.map((r) => r.text);
  const connect = () => {
    const socket = sockets.at(-1);
    if (!socket) throw new Error('no socket');
    socket.onopen?.();
    return socket;
  };
  return { registry, topic, texts, connect, sockets, timers };
}

describe('RunLogRegistry', () => {
  test('a second reader of the topic sees the lines received before it attached', () => {
    const { registry, topic, texts, connect } = setup();
    registry.attach(topic, () => {});
    const socket = connect();
    socket.push(topic, lines(true, 'a', 'b'));
    socket.push(topic, lines(false, 'c'));

    registry.attach(topic, () => {});
    expect(texts()).toEqual(['a', 'b', 'c']);

    socket.push(topic, lines(false, 'd'));
    expect(texts()).toEqual(['a', 'b', 'c', 'd']);
    // the server was asked once: only the first reader gets a backlog
    expect(socket.sent.filter((m) => m.type === 'subscribe')).toHaveLength(1);
  });

  test('closing and reopening one reader keeps the full log while another stays', () => {
    const { registry, topic, texts, connect } = setup();
    registry.attach(topic, () => {});
    const socket = connect();
    socket.push(topic, lines(true, 'a'));

    for (let i = 0; i < 3; i++) {
      const release = registry.attach(topic, () => {});
      expect(texts()).toEqual(['a']);
      release();
    }
    socket.push(topic, lines(false, 'b'));
    expect(texts()).toEqual(['a', 'b']);
  });

  test('both readers are notified of a new line', () => {
    const { registry, topic, connect } = setup();
    let first = 0;
    let second = 0;
    registry.attach(topic, () => first++);
    registry.attach(topic, () => second++);
    const socket = connect();
    const [beforeFirst, beforeSecond] = [first, second];
    socket.push(topic, lines(true, 'a'));
    expect(first).toBe(beforeFirst + 1);
    expect(second).toBe(beforeSecond + 1);
  });

  test('after the last reader leaves the topic is closed and nothing is kept', () => {
    const { registry, topic, texts, connect } = setup();
    const release = registry.attach(topic, () => {});
    const socket = connect();
    socket.push(topic, lines(true, 'a'));
    release();
    expect(socket.sent.at(-1)).toEqual({ type: 'unsubscribe', topic });
    expect(texts()).toEqual([]);
  });

  test('a reconnect replaces the lines with the server backlog once', () => {
    const { registry, topic, texts, connect, sockets, timers } = setup();
    registry.attach(topic, () => {});
    registry.attach(topic, () => {});
    const first = connect();
    first.push(topic, lines(true, 'a', 'b'));
    first.push(topic, lines(false, 'c'));

    first.drop(1006);
    timers.pop()?.(); // the retry timer is the newest; the ping is older
    expect(sockets).toHaveLength(2);
    const second = connect();
    second.push(topic, lines(true, 'a', 'b'));
    second.push(topic, lines(true, 'c'));
    second.push(topic, lines(false, 'd'));

    expect(texts()).toEqual(['a', 'b', 'c', 'd']);
  });

  test('a refused topic reaches every reader', () => {
    const { registry, topic, connect } = setup();
    registry.attach(topic, () => {});
    const socket = connect();
    socket.onmessage?.({
      data: JSON.stringify({ type: 'error', topic, code: 'forbidden' }),
    });
    expect(registry.getView(topic).error).toContain('not a member');
  });
});
