import { describe, expect, test } from 'bun:test';
import type { ConversationEntry } from '@agentdock/shared';
import {
  isDelivered,
  OUTBOX_CLOCK_SKEW_MS,
  OUTBOX_SENT_TTL_MS,
  type OutboxEntry,
  outboxReducer,
} from './outbox';

const SENT_AT = '2026-10-14T10:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(SENT_AT) + ms).toISOString();

const message = (body: string, seenAt = at(5_000)): ConversationEntry => ({
  from: 'orchestrator',
  id: `orchestrator:${body}`,
  at: seenAt,
  sender: 'me@example.com',
  sentAt: seenAt,
  body,
  mode: 'replaced',
});

const reply = (body: string): ConversationEntry => ({
  from: 'worker',
  id: `worker:${body}`,
  at: at(5_000),
  checkpoint: 'blocked',
  heading: 'blocked',
  body,
  position: 0,
});

const sent = (text: string): OutboxEntry => ({
  id: 'm1',
  text,
  at: SENT_AT,
  state: 'sent',
});

describe('outboxReducer', () => {
  test('send → ack → reconcile removes the entry once the message shows', () => {
    let state = outboxReducer([], {
      type: 'send',
      id: 'm1',
      text: 'Rebase on develop',
      at: SENT_AT,
    });
    expect(state).toEqual([
      { id: 'm1', text: 'Rebase on develop', at: SENT_AT, state: 'sending' },
    ]);
    state = outboxReducer(state, { type: 'ack', id: 'm1' });
    expect(state[0].state).toBe('sent');
    state = outboxReducer(state, {
      type: 'reconcile',
      entries: [message('From: me@example.com\n\nRebase on develop\n')],
      now: Date.parse(at(6_000)),
    });
    expect(state).toEqual([]);
  });

  test('a failure keeps the text and the reason; retry clears it', () => {
    let state = outboxReducer([], {
      type: 'send',
      id: 'm1',
      text: 'hi',
      at: SENT_AT,
    });
    state = outboxReducer(state, {
      type: 'fail',
      id: 'm1',
      error: 'runner offline',
    });
    expect(state[0]).toMatchObject({
      state: 'failed',
      text: 'hi',
      error: 'runner offline',
    });
    state = outboxReducer(state, { type: 'retry', id: 'm1', at: at(1_000) });
    expect(state[0]).toEqual({
      id: 'm1',
      text: 'hi',
      at: at(1_000),
      state: 'sending',
    });
  });

  test('discard drops only that entry', () => {
    const state = outboxReducer(
      [sent('a'), { ...sent('b'), id: 'm2', state: 'failed' }],
      { type: 'discard', id: 'm2' },
    );
    expect(state.map((e) => e.id)).toEqual(['m1']);
  });

  test('reconcile never drops one in flight or one that failed', () => {
    const entries = [message('hi')];
    const state = outboxReducer(
      [
        { ...sent('hi'), state: 'sending' },
        { ...sent('hi'), id: 'm2', state: 'failed', error: 'x' },
      ],
      { type: 'reconcile', entries, now: Date.parse(at(10 * 60_000)) },
    );
    expect(state.map((e) => e.state)).toEqual(['sending', 'failed']);
  });

  test('a sent entry that never shows expires after the TTL', () => {
    const keep = outboxReducer([sent('hi')], {
      type: 'reconcile',
      entries: [],
      now: Date.parse(at(OUTBOX_SENT_TTL_MS - 1)),
    });
    expect(keep).toHaveLength(1);
    const gone = outboxReducer([sent('hi')], {
      type: 'reconcile',
      entries: [],
      now: Date.parse(at(OUTBOX_SENT_TTL_MS)),
    });
    expect(gone).toEqual([]);
  });
});

describe('isDelivered', () => {
  test('matches an orchestrator message that carries the trimmed text', () => {
    expect(isDelivered(sent('  Rebase  '), [message('x Rebase y')])).toBe(true);
  });

  test('a worker section with the same words is not a delivery', () => {
    expect(isDelivered(sent('Rebase'), [reply('Rebase')])).toBe(false);
  });

  test('an older identical message does not count; clock skew does', () => {
    const before = at(-OUTBOX_CLOCK_SKEW_MS - 1);
    expect(isDelivered(sent('hi'), [message('hi', before)])).toBe(false);
    const skewed = at(-OUTBOX_CLOCK_SKEW_MS + 1);
    expect(isDelivered(sent('hi'), [message('hi', skewed)])).toBe(true);
  });
});
