import { describe, expect, test } from 'bun:test';
import type { BoardCardView } from '@agentdock/shared';
import {
  boardFilterCodec,
  boardMeta,
  countLabel,
  isFiltering,
  matchesFilter,
  NO_FILTER,
  unfilteredIndex,
} from './filter';
import { toItem } from './format';

const card = (over: Partial<BoardCardView>): BoardCardView =>
  ({
    id: 'id',
    number: 12,
    label: 'C-12',
    title: 'Change board',
    kind: 'feature',
    issueNumber: null,
    prNumber: null,
    round: null,
    ...over,
  }) as BoardCardView;

const running = { phase: 'running' } as BoardCardView['round'];
const waiting = { phase: 'waiting' } as BoardCardView['round'];
const background = { phase: 'background' } as BoardCardView['round'];

describe('matchesFilter', () => {
  test('no filter keeps everything', () => {
    expect(matchesFilter(toItem(card({})), NO_FILTER)).toBe(true);
    expect(isFiltering(NO_FILTER)).toBe(false);
  });

  test('text finds the title, the C-number, the issue and the PR', () => {
    const item = toItem(card({ issueNumber: 348, prNumber: 371 }));
    for (const text of ['board', 'c-12', '#348', '#371', 'PR 371']) {
      expect(matchesFilter(item, { ...NO_FILTER, text })).toBe(true);
    }
    expect(matchesFilter(item, { ...NO_FILTER, text: 'deploy' })).toBe(false);
  });

  test('kind and state narrow it', () => {
    const bug = toItem(card({ kind: 'bug', round: running }));
    expect(matchesFilter(bug, { ...NO_FILTER, kind: 'feature' })).toBe(false);
    expect(matchesFilter(bug, { ...NO_FILTER, kind: 'bug' })).toBe(true);
    expect(matchesFilter(bug, { ...NO_FILTER, state: 'running' })).toBe(true);
    expect(matchesFilter(bug, { ...NO_FILTER, state: 'waiting' })).toBe(false);
  });

  test('Waiting for you leaves out a card running in background (#390)', () => {
    const item = toItem(card({ round: background }));
    expect(matchesFilter(item, { ...NO_FILTER, state: 'waiting' })).toBe(false);
    expect(matchesFilter(item, { ...NO_FILTER, state: 'running' })).toBe(true);
    expect(boardMeta([item])).toEqual({ running: 1, waiting: 0 });
  });
});

describe('boardMeta', () => {
  test('counts running and waiting cards', () => {
    const items = [
      toItem(card({ round: running })),
      toItem(card({ round: running })),
      toItem(card({ round: waiting })),
      toItem(card({})),
    ];
    expect(boardMeta(items)).toEqual({ running: 2, waiting: 1 });
  });
});

describe('countLabel', () => {
  test('shows shown/total only while something is hidden', () => {
    expect(countLabel(3, 3)).toBe('3');
    expect(countLabel(1, 3)).toBe('1/3');
  });
});

describe('boardFilterCodec', () => {
  test('round-trips through the query string', () => {
    const filters = { text: 'deploy', kind: 'bug', state: 'error' } as const;
    const search = boardFilterCodec.search(filters);
    expect(boardFilterCodec.parse(new URLSearchParams(search))).toEqual(
      filters,
    );
  });

  test('an unknown kind or state reads as unset; unset writes nothing', () => {
    const parsed = boardFilterCodec.parse(
      new URLSearchParams('kind=chore&state=asleep'),
    );
    expect(parsed).toEqual(NO_FILTER);
    expect(boardFilterCodec.search(NO_FILTER)).toBe('');
  });
});

describe('unfilteredIndex', () => {
  const all = ['a', 'b', 'c', 'd'];

  test('lands before the visible card it was dropped on', () => {
    expect(unfilteredIndex(all, ['b', 'd'], 1)).toBe(3);
    expect(unfilteredIndex(all, ['b', 'd'], 0)).toBe(1);
  });

  test('the end of the visible list is the end of the column', () => {
    expect(unfilteredIndex(all, ['b', 'd'], 2)).toBe(4);
    expect(unfilteredIndex(all, [], 0)).toBe(4);
  });

  test('a card the column does not hold sends the drop to the end', () => {
    expect(unfilteredIndex(all, ['plan:1'], 0)).toBe(4);
  });
});
