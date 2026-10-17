import { describe, expect, test } from 'bun:test';
import type { AssistantConversationView } from '@agentdock/shared';
import { groupConversations } from './group-conversations';

const conversation = (id: string, updatedAt: string) =>
  ({ id, updatedAt }) as AssistantConversationView;

const keysOf = (
  stamp: string,
  now: string,
  timeZone: string | undefined = 'UTC',
) =>
  groupConversations([conversation('a', stamp)], new Date(now), timeZone).map(
    (group) => group.key,
  );

describe('groupConversations', () => {
  test('groups come back in display order, empty ones left out', () => {
    const groups = groupConversations(
      [
        conversation('old', '2026-08-01T10:00:00Z'),
        conversation('now', '2026-10-17T09:00:00Z'),
        conversation('yday', '2026-10-16T09:00:00Z'),
        conversation('mid', '2026-10-12T09:00:00Z'),
      ],
      new Date('2026-10-17T12:00:00Z'),
      'UTC',
    );
    expect(groups.map((g) => g.key)).toEqual([
      'today',
      'yesterday',
      'week',
      'earlier',
    ]);
    expect(groups.map((g) => g.label)).toEqual([
      'Today',
      'Yesterday',
      'Previous 7 days',
      'Earlier',
    ]);
    expect(groupConversations([], new Date(), 'UTC')).toEqual([]);
  });

  test('keeps the order the API sent inside a group', () => {
    const [group] = groupConversations(
      [
        conversation('b', '2026-10-17T11:00:00Z'),
        conversation('a', '2026-10-17T01:00:00Z'),
      ],
      new Date('2026-10-17T12:00:00Z'),
      'UTC',
    );
    expect(group?.conversations.map((c) => c.id)).toEqual(['b', 'a']);
  });

  test('is a calendar day, not 24 hours: 23:50 yesterday is Yesterday at 00:10', () => {
    expect(keysOf('2026-10-16T23:50:00Z', '2026-10-17T00:10:00Z')).toEqual([
      'yesterday',
    ]);
  });

  test('00:00 today is Today at 23:59; 23:59 the day before is Yesterday', () => {
    expect(keysOf('2026-10-17T00:00:00Z', '2026-10-17T23:59:00Z')).toEqual([
      'today',
    ]);
    expect(keysOf('2026-10-16T23:59:59Z', '2026-10-17T23:59:00Z')).toEqual([
      'yesterday',
    ]);
  });

  test('Previous 7 days is 2 to 7 days back; 8 is Earlier', () => {
    const now = '2026-10-17T12:00:00Z';
    expect(keysOf('2026-10-15T23:59:00Z', now)).toEqual(['week']);
    expect(keysOf('2026-10-10T00:00:00Z', now)).toEqual(['week']);
    expect(keysOf('2026-10-09T23:59:00Z', now)).toEqual(['earlier']);
  });

  test('a stamp ahead of the clock is Today', () => {
    expect(keysOf('2026-10-18T03:00:00Z', '2026-10-17T12:00:00Z')).toEqual([
      'today',
    ]);
  });

  test("the person's timezone decides the day", () => {
    // 20:30Z is 23:30 on the 16th in Kyiv (UTC+3); an hour later it is the 17th there.
    expect(
      keysOf('2026-10-16T20:30:00Z', '2026-10-16T21:30:00Z', 'Europe/Kyiv'),
    ).toEqual(['yesterday']);
    expect(
      keysOf('2026-10-16T20:30:00Z', '2026-10-16T21:30:00Z', 'UTC'),
    ).toEqual(['today']);
  });

  test('a DST change does not shift the day count', () => {
    // Europe/Kyiv leaves summer time on 2026-10-25 (03:00 → 02:00).
    expect(
      keysOf('2026-10-24T12:00:00Z', '2026-10-26T12:00:00Z', 'Europe/Kyiv'),
    ).toEqual(['week']);
    expect(
      keysOf('2026-10-25T12:00:00Z', '2026-10-26T12:00:00Z', 'Europe/Kyiv'),
    ).toEqual(['yesterday']);
  });
});
