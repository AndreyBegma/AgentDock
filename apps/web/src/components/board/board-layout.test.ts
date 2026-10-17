import { describe, expect, test } from 'bun:test';
import { NARROW_MAX_WIDTH_PX } from '../shell/narrow';
import {
  boardColumnWidth,
  PHONE_MAX_WIDTH_PX,
  visibleColumns,
} from './board-layout';

const column = (id: string, cards: number) => ({
  id,
  cards: Array.from({ length: cards }, (_, i) => i),
});

describe('visibleColumns', () => {
  test('a phone drops an empty Inbox', () => {
    const columns = [column('inbox', 0), column('todo', 2)];
    expect(visibleColumns(columns, true).map((c) => c.id)).toEqual(['todo']);
  });

  test('a phone keeps a non-empty Inbox', () => {
    const columns = [column('inbox', 1), column('todo', 0)];
    expect(visibleColumns(columns, true).map((c) => c.id)).toEqual([
      'inbox',
      'todo',
    ]);
  });

  test('wider screens keep an empty Inbox; other empty columns stay on a phone', () => {
    const columns = [column('inbox', 0), column('todo', 0)];
    expect(visibleColumns(columns, false)).toHaveLength(2);
    expect(visibleColumns([column('todo', 0)], true)).toHaveLength(1);
  });
});

describe('boardColumnWidth', () => {
  test('five columns share the scroller, with a floor', () => {
    expect(boardColumnWidth(5)).toBe(
      'max(13.5rem, calc((100% - 4 * 0.75rem) / 5))',
    );
  });

  test('folded strips and their gaps come off the width the open columns share', () => {
    expect(boardColumnWidth(4, 1)).toBe(
      'max(13.5rem, calc((100% - 1 * (2.75rem + 0.75rem) - 3 * 0.75rem) / 4))',
    );
  });

  test('never divides by zero', () => {
    expect(boardColumnWidth(0)).toContain('/ 1))');
  });
});

describe('PHONE_MAX_WIDTH_PX (#497)', () => {
  test('is the shell breakpoint the capsule shows below, `lg`', () => {
    expect(PHONE_MAX_WIDTH_PX).toBe(NARROW_MAX_WIDTH_PX);
    expect(PHONE_MAX_WIDTH_PX).toBe(1024);
  });
});
