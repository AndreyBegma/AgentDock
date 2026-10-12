import { describe, expect, test } from 'bun:test';
import type { NotificationRuleView, NotificationView } from '@agentdock/shared';
import {
  applyNew,
  applyRead,
  fromDateInput,
  isFutureDay,
  parseNewLive,
  parseReadLive,
  relativeTime,
  ruleRows,
  ruleUpdate,
  safeLink,
  toDateInput,
} from './format';

const view = (patch: Partial<NotificationView> = {}): NotificationView => ({
  id: '1',
  kind: 'pane.prompt',
  projectId: 'p1',
  projectName: 'Alpha',
  runnerId: null,
  slot: 's1',
  issue: null,
  title: 'Prompt',
  body: 'waiting',
  link: '/projects/p1/fleet',
  count: 1,
  firstAt: '2026-10-08T10:00:00.000Z',
  lastAt: '2026-10-08T10:00:00.000Z',
  readAt: null,
  muted: false,
  ...patch,
});

describe('applyNew', () => {
  test('a new row goes first and the count follows the server', () => {
    const state = { items: [view({ id: '1' })], unreadCount: 1 };
    const next = applyNew(state, {
      notification: view({ id: '2' }),
      unreadCount: 2,
    });
    expect(next.items.map((i) => i.id)).toEqual(['2', '1']);
    expect(next.unreadCount).toBe(2);
  });

  test('a fold replaces its row and moves it up, without duplicating', () => {
    const state = {
      items: [view({ id: '2' }), view({ id: '1', count: 1 })],
      unreadCount: 2,
    };
    const next = applyNew(state, {
      notification: view({ id: '1', count: 5 }),
      unreadCount: 2,
    });
    expect(next.items.map((i) => [i.id, i.count])).toEqual([
      ['1', 5],
      ['2', 1],
    ]);
  });

  test('the bell keeps its newest 20', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      view({ id: `${i + 10}` }),
    );
    const next = applyNew(
      { items, unreadCount: 20 },
      { notification: view({ id: '99' }), unreadCount: 21 },
      { limit: 20 },
    );
    expect(next.items).toHaveLength(20);
    expect(next.items[0]?.id).toBe('99');
  });

  test('the Unread tab ignores a muted or read arrival but keeps the count', () => {
    const next = applyNew(
      { items: [], unreadCount: 3 },
      { notification: view({ id: '7', muted: true }), unreadCount: 3 },
      { unreadOnly: true },
    );
    expect(next.items).toEqual([]);
    expect(next.unreadCount).toBe(3);
  });

  test('a fold that became read leaves the Unread tab', () => {
    const next = applyNew(
      { items: [view({ id: '1' })], unreadCount: 1 },
      {
        notification: view({ id: '1', readAt: '2026-10-08T11:00:00.000Z' }),
        unreadCount: 0,
      },
      { unreadOnly: true },
    );
    expect(next.items).toEqual([]);
  });
});

describe('applyRead', () => {
  const state = {
    items: [view({ id: '1' }), view({ id: '2' })],
    unreadCount: 2,
  };
  const at = '2026-10-08T12:00:00.000Z';

  test('marks the listed ids read', () => {
    const next = applyRead(state, { ids: ['2'], unreadCount: 1 }, at);
    expect(next.items.map((i) => i.readAt)).toEqual([null, at]);
    expect(next.unreadCount).toBe(1);
  });

  test('ids null marks all, and keeps an earlier readAt', () => {
    const early = '2026-10-08T09:00:00.000Z';
    const next = applyRead(
      {
        items: [view({ id: '1', readAt: early }), view({ id: '2' })],
        unreadCount: 1,
      },
      { ids: null, unreadCount: 0 },
      at,
    );
    expect(next.items.map((i) => i.readAt)).toEqual([early, at]);
  });

  test('the Unread tab drops what was read', () => {
    const next = applyRead(state, { ids: ['1'], unreadCount: 1 }, at, {
      unreadOnly: true,
    });
    expect(next.items.map((i) => i.id)).toEqual(['2']);
  });
});

describe('live parsing', () => {
  test('accepts a well-formed frame and refuses the rest', () => {
    const good = { notification: view(), unreadCount: 1 };
    expect(parseNewLive('notification.new', good)).toEqual(good);
    expect(parseNewLive('notification.read', good)).toBeNull();
    expect(parseNewLive('notification.new', { unreadCount: 1 })).toBeNull();
    expect(parseNewLive('notification.new', null)).toBeNull();
    expect(
      parseReadLive('notification.read', { ids: null, unreadCount: 0 }),
    ).not.toBeNull();
    expect(
      parseReadLive('notification.read', { ids: ['1'], unreadCount: 0 }),
    ).not.toBeNull();
    expect(
      parseReadLive('notification.read', { ids: [1], unreadCount: 0 }),
    ).toBeNull();
    expect(parseReadLive('notification.read', { ids: null })).toBeNull();
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-10-08T12:00:00.000Z');
  test('steps from seconds to days', () => {
    expect(relativeTime('2026-10-08T11:59:40.000Z', now)).toBe('just now');
    expect(relativeTime('2026-10-08T11:55:00.000Z', now)).toBe('5 min ago');
    expect(relativeTime('2026-10-08T09:00:00.000Z', now)).toBe('3 h ago');
    expect(relativeTime('2026-10-06T12:00:00.000Z', now)).toBe('2 d ago');
    expect(relativeTime('nope', now)).toBe('');
  });
});

describe('safeLink', () => {
  test('only in-app paths are followed', () => {
    expect(safeLink('/projects/p1/fleet')).toBe('/projects/p1/fleet');
    expect(safeLink('https://evil.example')).toBeNull();
    expect(safeLink('//evil.example')).toBeNull();
    expect(safeLink(null)).toBeNull();
  });
});

describe('mute dates', () => {
  test('a chosen day ends at the end of that local day and round-trips', () => {
    const iso = fromDateInput('2026-10-12');
    expect(iso).not.toBeNull();
    expect(toDateInput(iso)).toBe('2026-10-12');
    const end = new Date(iso as string);
    expect([end.getHours(), end.getMinutes()]).toEqual([23, 59]);
  });

  test('empty and malformed values mean "until removed"', () => {
    expect(fromDateInput('')).toBeNull();
    expect(fromDateInput('12/10/2026')).toBeNull();
    expect(toDateInput(null)).toBe('');
  });

  test('a past day is not a valid mute end', () => {
    const now = new Date(2026, 9, 8, 12).getTime();
    expect(isFutureDay('2026-10-08', now)).toBe(true);
    expect(isFutureDay('2026-10-07', now)).toBe(false);
    expect(isFutureDay('', now)).toBe(false);
  });
});

describe('ruleRows', () => {
  const rule = (
    patch: Partial<NotificationRuleView>,
  ): NotificationRuleView => ({
    kind: 'pane.prompt',
    inApp: true,
    telegram: true,
    channels: ['inApp', 'telegram'],
    isDefault: true,
    ...patch,
  });

  test('Telegram is disabled until linked', () => {
    const [row] = ruleRows([rule({})], false);
    expect(row?.telegramDisabled).toBe(true);
    expect(row?.telegramNote).toBe('unlinked');
    const [linked] = ruleRows([rule({})], true);
    expect(linked?.telegramDisabled).toBe(false);
    expect(linked?.telegramNote).toBeNull();
  });

  test('an in-app-only kind never shows Telegram on', () => {
    const [row] = ruleRows(
      [rule({ kind: 'runner.online', channels: ['inApp'], telegram: false })],
      true,
    );
    expect(row?.telegram).toBe(false);
    expect(row?.telegramDisabled).toBe(true);
    expect(row?.telegramNote).toBe('in-app only');
  });
});

describe('ruleUpdate', () => {
  test('changes one channel and keeps the other', () => {
    expect(
      ruleUpdate(
        { kind: 'quota.hit', inApp: true, telegram: true },
        'telegram',
        false,
      ),
    ).toEqual({ rules: [{ kind: 'quota.hit', inApp: true, telegram: false }] });
  });
});
