import { describe, expect, test } from 'bun:test';
import { boardColumnWidth, visibleColumns } from './board-layout';

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

  test('never divides by zero', () => {
    expect(boardColumnWidth(0)).toContain('/ 1))');
  });
});
