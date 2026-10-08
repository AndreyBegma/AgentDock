import { describe, expect, it } from 'bun:test';
import type { SubscribeMessage } from '@agentdock/shared/protocol';
import { fakeTmux } from '../control/testing';
import { FakeClock } from '../testing/fake-clock';
import { memoryLogger } from '../testing/fixtures';
import { type PaneOutbound, PaneStreamer } from './streamer';

const settle = async () => {
  for (let i = 0; i < 10; i++) await Bun.sleep(0);
};

const setup = (
  options: {
    sessions?: Record<string, string>;
    maxSubscriptions?: number;
    maxFrameBytes?: number;
  } = {},
) => {
  const tmux = fakeTmux({
    sessions: options.sessions ?? { 'cs-i42': 'one\ntwo\n' },
    worktrees: ['/srv/.wt-widget-i42', '/srv/.wt-widget-i7'],
  });
  const clock = new FakeClock();
  const sent: PaneOutbound[] = [];
  const streamer = new PaneStreamer({
    exec: tmux.deps.exec,
    clock,
    watchedProjects: tmux.deps.watchedProjects,
    send: (message) => {
      sent.push(message);
      return true;
    },
    log: memoryLogger().log,
    maxSubscriptions: options.maxSubscriptions,
    maxFrameBytes: options.maxFrameBytes,
  });
  const sub = (id: string, over: Partial<SubscribeMessage> = {}) =>
    streamer.subscribe({
      type: 'subscribe',
      id,
      kind: 'pane',
      projectId: 'prj_1',
      root: '/srv/widget',
      slot: 'i42',
      ...over,
    });
  const captures = () =>
    tmux.tmuxCalls().filter((c) => c[0] === 'capture-pane');
  const framesOf = (id: string) =>
    sent.flatMap((m) => (m.type === 'pane' && m.id === id ? [m.frame] : []));
  const text = (value: string) => tmux.sessions.set('cs-i42', value);
  return { tmux, clock, sent, streamer, sub, captures, framesOf, text };
};

describe('PaneStreamer', () => {
  it('sends a full frame first, then only patches, then nothing when output stops', async () => {
    const t = setup();
    await t.sub('a');
    await settle();
    expect(t.framesOf('a')).toEqual([
      { type: 'full', lines: ['one', 'two'], cursor: { x: 0, y: 1 } },
    ]);

    t.text('one\ntwo\nthree\n');
    t.clock.advance(1000);
    await settle();
    expect(t.framesOf('a')[1]).toEqual({
      type: 'patch',
      from: 2,
      lines: ['three'],
    });

    t.text('one\nTWO\nthree\n');
    t.clock.advance(1000);
    await settle();
    expect(t.framesOf('a')[2]).toEqual({
      type: 'patch',
      from: 1,
      lines: ['TWO', 'three'],
    });

    const before = t.sent.length;
    t.clock.advance(5000);
    await settle();
    expect(t.sent.length).toBe(before);
  });

  it('captures with the exact-match target, colour, joined lines and history', async () => {
    const t = setup();
    await t.sub('a');
    await settle();
    expect(t.captures()[0]).toEqual([
      'capture-pane',
      '-p',
      '-e',
      '-J',
      '-t',
      '=cs-i42:',
      '-S',
      '-2000',
    ]);
  });

  it('runs one capture loop for two subscriptions and stops with the last', async () => {
    const t = setup();
    await t.sub('a');
    await t.sub('b');
    await settle();
    expect(t.streamer.loopCount).toBe(1);
    const base = t.captures().length;
    t.clock.advance(1000);
    await settle();
    expect(t.captures().length).toBe(base + 1);

    t.streamer.unsubscribe('a');
    t.clock.advance(1000);
    await settle();
    expect(t.captures().length).toBe(base + 2);

    t.streamer.unsubscribe('b');
    expect(t.streamer.loopCount).toBe(0);
    t.clock.advance(5000);
    await settle();
    expect(t.captures().length).toBe(base + 2);
  });

  it('gives a late joiner a full frame and the earlier one patches', async () => {
    const t = setup();
    await t.sub('a');
    await settle();
    await t.sub('b');
    t.text('one\ntwo\nthree\n');
    t.clock.advance(1000);
    await settle();
    expect(t.framesOf('a').map((f) => f.type)).toEqual(['full', 'patch']);
    expect(t.framesOf('b')).toEqual([
      {
        type: 'full',
        lines: ['one', 'two', 'three'],
        cursor: { x: 0, y: 2 },
      },
    ]);
  });

  it('resends a full frame every 60 s', async () => {
    const t = setup();
    await t.sub('a');
    await settle();
    t.clock.advance(59_000);
    await settle();
    expect(t.framesOf('a').map((f) => f.type)).toEqual(['full']);
    t.clock.advance(1000);
    await settle();
    expect(t.framesOf('a').map((f) => f.type)).toEqual(['full', 'full']);
  });

  it('delivers masked secrets', async () => {
    const t = setup();
    t.text(`token ghp_${'a'.repeat(36)}\n`);
    await t.sub('a');
    await settle();
    expect(JSON.stringify(t.sent)).not.toContain('ghp_');
    expect(t.framesOf('a')[0]).toMatchObject({ lines: ['token •••'] });
  });

  it('truncates a frame from the top to the byte cap', async () => {
    const t = setup({ maxFrameBytes: 2000 });
    t.text(
      `${Array.from({ length: 200 }, (_, i) => `row-${i}`.padEnd(40)).join('\n')}\n`,
    );
    await t.sub('a');
    await settle();
    const frame = t.framesOf('a')[0];
    if (frame?.type !== 'full') throw new Error('expected a full frame');
    expect(frame.lines.at(-1)).toStartWith('row-199');
    expect(frame.lines.length).toBeLessThan(200);
    expect(JSON.stringify(t.sent[0]).length).toBeLessThanOrEqual(2000);
  });

  it('refuses the 11th subscription with too_many_viewers', async () => {
    const t = setup({ maxSubscriptions: 10 });
    for (let i = 0; i < 10; i++) await t.sub(`s${i}`);
    await t.sub('s10');
    expect(t.sent).toContainEqual({
      type: 'subscribe.error',
      id: 's10',
      code: 'too_many_viewers',
    });
    expect(t.streamer.subscriptionCount).toBe(10);
  });

  it('counts subscriptions still resolving against the cap', async () => {
    const t = setup({ maxSubscriptions: 1 });
    const first = t.sub('a');
    await t.sub('b');
    await first;
    expect(t.sent).toContainEqual({
      type: 'subscribe.error',
      id: 'b',
      code: 'too_many_viewers',
    });
  });

  it('ends every subscription when the session disappears, and drops them', async () => {
    const t = setup();
    await t.sub('a');
    await t.sub('b');
    await settle();
    t.tmux.sessions.delete('cs-i42');
    t.clock.advance(1000);
    await settle();
    expect(t.framesOf('a').at(-1)).toEqual({ type: 'ended' });
    expect(t.framesOf('b').at(-1)).toEqual({ type: 'ended' });
    expect(t.streamer.loopCount).toBe(0);
    expect(t.streamer.subscriptionCount).toBe(0);
    const before = t.sent.length;
    t.clock.advance(5000);
    await settle();
    expect(t.sent.length).toBe(before);
  });

  it('refuses a project or root the watch list does not hold: forbidden', async () => {
    const t = setup();
    await t.sub('a', { projectId: 'prj_other' });
    await t.sub('b', { root: '/srv/elsewhere' });
    expect(t.sent).toEqual([
      { type: 'subscribe.error', id: 'a', code: 'forbidden' },
      { type: 'subscribe.error', id: 'b', code: 'forbidden' },
    ]);
    expect(t.captures()).toEqual([]);
  });

  it('refuses a slot without a worktree in the project: not_found', async () => {
    const t = setup({ sessions: { 'cs-i42': '', 'cs-i99': '' } });
    await t.sub('a', { slot: 'i99' });
    expect(t.sent).toEqual([
      { type: 'subscribe.error', id: 'a', code: 'not_found' },
    ]);
    expect(t.captures()).toEqual([]);
  });

  it('refuses a slot with no live session, or only another project’s: not_found', async () => {
    const t = setup({ sessions: { 'cs-other--i42': 'x' } });
    await t.sub('a');
    await t.sub('b', { slot: 'i7' });
    expect(t.sent).toEqual([
      { type: 'subscribe.error', id: 'a', code: 'not_found' },
      { type: 'subscribe.error', id: 'b', code: 'not_found' },
    ]);
  });

  it('does not match a prefix of another slot’s session', async () => {
    const t = setup({ sessions: { 'cs-i42': 'x' } });
    await t.sub('a', { slot: 'i4' });
    expect(t.sent).toEqual([
      { type: 'subscribe.error', id: 'a', code: 'not_found' },
    ]);
  });

  it('honours an unsubscribe that arrives while the slot resolves', async () => {
    const t = setup();
    const pending = t.sub('a');
    t.streamer.unsubscribe('a');
    await pending;
    await settle();
    expect(t.streamer.loopCount).toBe(0);
    expect(t.sent).toEqual([]);
    expect(t.captures()).toEqual([]);
  });

  it('ignores a repeated id', async () => {
    const t = setup();
    await t.sub('a');
    await t.sub('a');
    await settle();
    expect(t.streamer.subscriptionCount).toBe(1);
    expect(t.framesOf('a')).toHaveLength(1);
  });

  it('reset drops every loop and subscription', async () => {
    const t = setup();
    await t.sub('a');
    await settle();
    t.streamer.reset();
    expect(t.streamer.loopCount).toBe(0);
    const before = t.captures().length;
    t.clock.advance(5000);
    await settle();
    expect(t.captures().length).toBe(before);
  });
});
