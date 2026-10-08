import { describe, expect, it } from 'bun:test';
import { paneTopic } from '../protocol/pane';
import {
  liveClientMessageSchema,
  liveServerMessageSchema,
  liveTopicSchema,
  parseLiveTopic,
} from './index';

describe('live topics', () => {
  it.each([
    'admin',
    'runner:abc',
    'project:p_1',
    'user:7c0f-9a',
    'pane:cmg1a2b3c:i18-api',
    `pane:p1:${'s'.repeat(64)}`,
  ])('accepts %s', (topic) => {
    expect(liveTopicSchema.safeParse(topic).success).toBe(true);
  });

  it.each([
    '',
    'admin:1',
    'user:',
    'user',
    'session:1',
    'user:a b',
    'user:a:b',
    `user:${'x'.repeat(65)}`,
    'pane:p1',
    'pane:p1:',
    'pane:p1:I18',
    'pane:p1:-slot',
    'pane:p1:a.b',
    'pane:p1:a:b',
    `pane:p1:${'s'.repeat(65)}`,
    'project:p1:i18',
  ])('refuses %p', (topic) => {
    expect(liveTopicSchema.safeParse(topic).success).toBe(false);
  });

  it('splits prefix and id', () => {
    expect(parseLiveTopic('admin')).toEqual({ prefix: 'admin', id: null });
    expect(parseLiveTopic('runner:r1')).toEqual({ prefix: 'runner', id: 'r1' });
    expect(parseLiveTopic('pane:p1:i18-api')).toEqual({
      prefix: 'pane',
      id: 'p1:i18-api',
    });
  });

  it('builds pane topics it accepts', () => {
    expect(liveTopicSchema.safeParse(paneTopic('p_1', 'i18-api')).success).toBe(
      true,
    );
  });
});

describe('live messages', () => {
  it('parses every client message', () => {
    for (const message of [
      { type: 'subscribe', topic: 'user:u1' },
      { type: 'unsubscribe', topic: 'admin' },
      { type: 'ping' },
    ] as const) {
      expect(liveClientMessageSchema.parse(message)).toEqual(message);
    }
  });

  it('refuses a subscribe without a well-formed topic', () => {
    expect(
      liveClientMessageSchema.safeParse({ type: 'subscribe' }).success,
    ).toBe(false);
    expect(
      liveClientMessageSchema.safeParse({ type: 'subscribe', topic: 'x:y' })
        .success,
    ).toBe(false);
  });

  it('parses every server message', () => {
    for (const message of [
      { type: 'subscribed', topic: 'user:u1' },
      { type: 'error', code: 'invalid_message' },
      { type: 'error', topic: 'admin', code: 'forbidden' },
      { type: 'error', topic: 'pane:p1:i18-api', code: 'not_found' },
      { type: 'error', topic: 'pane:p1:i18-api', code: 'too_many_viewers' },
      {
        type: 'event',
        topic: 'runner:r1',
        event: 'runner.status',
        data: { status: 'online' },
        ts: '2026-10-07T18:36:02.335Z',
      },
      { type: 'pong' },
    ] as const) {
      expect(liveServerMessageSchema.parse(message)).toEqual(message);
    }
  });

  it('refuses an unknown error code', () => {
    expect(
      liveServerMessageSchema.safeParse({ type: 'error', code: 'nope' })
        .success,
    ).toBe(false);
  });
});
