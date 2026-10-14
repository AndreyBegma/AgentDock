import { describe, expect, test } from 'bun:test';
import { ApiError } from '../api';
import { applyDrop } from './board-state';
import { boardView, card } from './fixtures';
import { describeBoardError } from './format';

const ids = (view: ReturnType<typeof boardView>, column: string) =>
  view.columns.find((c) => c.column === column)?.cards.map((c) => c.id);

describe('applyDrop', () => {
  test('moves a card to another column at the dropped index', () => {
    const view = boardView([
      card(1, 'todo'),
      card(2, 'finished'),
      card(3, 'finished'),
    ]);
    const next = applyDrop(view, {
      id: 'card-1',
      fromColumnId: 'todo',
      toColumnId: 'finished',
      index: 1,
    });
    expect(ids(next, 'todo')).toEqual([]);
    expect(ids(next, 'finished')).toEqual(['card-2', 'card-1', 'card-3']);
    expect(
      next.columns.find((c) => c.column === 'finished')?.cards[1]?.column,
    ).toBe('finished');
  });

  test('reorders inside a column, index counted without the moving card', () => {
    const view = boardView([card(1, 'todo'), card(2, 'todo'), card(3, 'todo')]);
    const next = applyDrop(view, {
      id: 'card-1',
      fromColumnId: 'todo',
      toColumnId: 'todo',
      index: 2,
    });
    expect(ids(next, 'todo')).toEqual(['card-2', 'card-3', 'card-1']);
  });

  test('does not mutate the view it was given (so a rollback is the old view)', () => {
    const view = boardView([card(1, 'todo')]);
    applyDrop(view, {
      id: 'card-1',
      fromColumnId: 'todo',
      toColumnId: 'completed',
      index: 0,
    });
    expect(ids(view, 'todo')).toEqual(['card-1']);
    expect(ids(view, 'completed')).toEqual([]);
  });

  test('an unknown card leaves the view as it is', () => {
    const view = boardView([card(1, 'todo')]);
    expect(
      applyDrop(view, {
        id: 'x',
        fromColumnId: 'todo',
        toColumnId: 'finished',
        index: 0,
      }),
    ).toBe(view);
  });
});

describe('describeBoardError', () => {
  const error = (
    status: number,
    code: string,
    body: Record<string, unknown> = {},
  ) =>
    new ApiError(status, code as never, 'server text', undefined, {
      error: code,
      ...body,
    });

  test('a refused move says why a toast can show', () => {
    expect(
      describeBoardError(
        error(409, 'move_refused', { reason: 'card_running' }),
      ),
    ).toContain('worker is running');
  });

  test('the Run errors have their own sentences', () => {
    expect(describeBoardError(error(409, 'max_running'))).toContain('limit');
    expect(describeBoardError(error(409, 'budget_exceeded'))).toContain(
      'budget',
    );
    expect(describeBoardError(error(422, 'no_spec_dir'))).toContain(
      'spec directory',
    );
    expect(
      describeBoardError(error(503, 'command_unavailable'), 'r1'),
    ).toContain('r1');
  });

  test('a viewer’s 403 is explained', () => {
    expect(describeBoardError(new ApiError(403, undefined, 'x'))).toContain(
      'operators',
    );
  });
});
