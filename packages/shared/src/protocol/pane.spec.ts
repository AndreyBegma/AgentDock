import { describe, expect, it } from 'bun:test';
import {
  messageSchema,
  PANE_LIVE_EVENTS,
  paneFrameSchema,
  paneMessageSchema,
  paneTopic,
  runnerMessageSchema,
  runnerMessageTypes,
  serverMessageSchema,
  serverMessageTypes,
  subscribeErrorMessageSchema,
  subscribeMessageSchema,
  unsubscribeMessageSchema,
} from './index';

const subscribe = {
  type: 'subscribe',
  id: 'pane_1',
  kind: 'pane',
  projectId: 'prj_1',
  root: '/home/dev/repo',
  slot: 'i18-protocol',
} as const;

describe('pane frames', () => {
  it.each([
    {
      type: 'full',
      lines: ['a', '\u001b[32mb\u001b[0m'],
      cursor: { x: 0, y: 1 },
    },
    { type: 'full', lines: [], cursor: { x: 0, y: 0 } },
    { type: 'patch', from: 0, lines: ['a'] },
    { type: 'patch', from: 3, lines: [] },
    { type: 'ended' },
  ])('parses %o', (frame) => {
    expect(paneFrameSchema.safeParse(frame).error).toBeUndefined();
  });

  it.each([
    { type: 'full', lines: ['a'] },
    { type: 'full', lines: ['a'], cursor: { x: -1, y: 0 } },
    { type: 'patch', lines: ['a'] },
    { type: 'patch', from: -1, lines: [] },
    { type: 'patch', from: 1.5, lines: [] },
    { type: 'diff', lines: [] },
    { type: 'input', keys: 'ls\n' },
  ])('rejects %o', (frame) => {
    expect(paneFrameSchema.safeParse(frame).success).toBe(false);
  });
});

describe('subscribe', () => {
  it('parses a pane subscription', () => {
    expect(subscribeMessageSchema.parse(subscribe)).toEqual(subscribe);
  });

  it.each([
    ['without an id', { ...subscribe, id: undefined }],
    ['with an empty id', { ...subscribe, id: '' }],
    ['without kind', { ...subscribe, kind: undefined }],
    ['of another kind', { ...subscribe, kind: 'shell' }],
    ['with a relative root', { ...subscribe, root: 'repo' }],
    ['without a root', { ...subscribe, root: undefined }],
    ['without a projectId', { ...subscribe, projectId: '' }],
  ])('rejects a subscription %s', (_case, message) => {
    expect(subscribeMessageSchema.safeParse(message).success).toBe(false);
  });

  it.each([
    'i18-protocol',
    'i5',
    '42',
    'a'.repeat(64),
  ])('accepts slot %s', (slot) => {
    expect(
      subscribeMessageSchema.safeParse({ ...subscribe, slot }).success,
    ).toBe(true);
  });

  it.each([
    '',
    '-lead',
    'I18',
    'cs:1',
    'a.b',
    'a/b',
    'a b',
    'a_b',
    'a'.repeat(65),
  ])('rejects slot %p, which would reach a tmux target', (slot) => {
    expect(
      subscribeMessageSchema.safeParse({ ...subscribe, slot }).success,
    ).toBe(false);
  });

  it('unsubscribes by id only', () => {
    expect(
      unsubscribeMessageSchema.safeParse({ type: 'unsubscribe', id: 'pane_1' })
        .success,
    ).toBe(true);
    expect(
      unsubscribeMessageSchema.safeParse({ type: 'unsubscribe' }).success,
    ).toBe(false);
  });
});

describe('pane and subscribe.error', () => {
  it('requires the subscription id on a frame', () => {
    const frame = { type: 'ended' };
    expect(
      paneMessageSchema.safeParse({ type: 'pane', id: 'pane_1', frame })
        .success,
    ).toBe(true);
    expect(paneMessageSchema.safeParse({ type: 'pane', frame }).success).toBe(
      false,
    );
  });

  it.each([
    'not_found',
    'too_many_viewers',
    'forbidden',
  ])('accepts error code %s', (code) => {
    expect(
      subscribeErrorMessageSchema.safeParse({
        type: 'subscribe.error',
        id: 'pane_1',
        code,
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown error code', () => {
    expect(
      subscribeErrorMessageSchema.safeParse({
        type: 'subscribe.error',
        id: 'pane_1',
        code: 'busy',
      }).success,
    ).toBe(false);
  });
});

describe('message unions', () => {
  it('routes each pane message in its own direction only', () => {
    const fromServer = [subscribe, { type: 'unsubscribe', id: 'pane_1' }];
    const fromRunner = [
      { type: 'pane', id: 'pane_1', frame: { type: 'ended' } },
      { type: 'subscribe.error', id: 'pane_1', code: 'forbidden' },
    ];
    for (const m of fromServer) {
      expect(serverMessageSchema.safeParse(m).success).toBe(true);
      expect(runnerMessageSchema.safeParse(m).success).toBe(false);
    }
    for (const m of fromRunner) {
      expect(runnerMessageSchema.safeParse(m).success).toBe(true);
      expect(serverMessageSchema.safeParse(m).success).toBe(false);
    }
  });

  it('lists subscribe.error as a runner message type', () => {
    expect(runnerMessageTypes).toContain('subscribe.error');
    expect(serverMessageTypes).toContain('subscribe');
    expect(serverMessageTypes).toContain('unsubscribe');
  });

  it('has no message type that carries input to a pane', () => {
    const types: string[] = [...runnerMessageTypes, ...serverMessageTypes];
    for (const type of types) {
      expect(type).not.toMatch(/input|keys|attach|write/);
    }
    for (const type of ['pane.input', 'send-keys', 'pane.attach']) {
      expect(messageSchema.safeParse({ type, id: 'x' }).success).toBe(false);
    }
  });
});

describe('live topic', () => {
  it('spells the topic and the relayed event types', () => {
    expect(paneTopic('prj_1', 'i18-protocol')).toBe('pane:prj_1:i18-protocol');
    expect(PANE_LIVE_EVENTS).toEqual({
      frame: 'pane.frame',
      ended: 'pane.ended',
    });
  });
});
