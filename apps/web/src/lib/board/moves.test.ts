import { describe, expect, test } from 'bun:test';
import { decideDrop, moveRequest } from './board-state';
import { boardView, card, round } from './fixtures';

const drop = (id: string, from: string, to: string, index = 0) => ({
  id,
  fromColumnId: from,
  toColumnId: to,
  index,
});

describe('decideDrop', () => {
  test('To Do → In progress asks "Run the worker?" and never starts one', () => {
    const view = boardView([card(1, 'todo')]);
    const decision = decideDrop(view, drop('card-1', 'todo', 'in_progress'));
    expect(decision.kind).toBe('offer-run');
  });

  test('Finished → In progress asks too', () => {
    const view = boardView([card(1, 'finished', { round: round('finished') })]);
    expect(
      decideDrop(view, drop('card-1', 'finished', 'in_progress')).kind,
    ).toBe('offer-run');
  });

  test('"Just move" skips the offer and is a plain move', () => {
    const view = boardView([card(1, 'todo')]);
    const decision = decideDrop(view, drop('card-1', 'todo', 'in_progress'), {
      skipRunOffer: true,
    });
    expect(decision.kind).toBe('move');
  });

  test('leaving In progress with a worker running asks to stop it', () => {
    const view = boardView([
      card(1, 'in_progress', { round: round('running') }),
    ]);
    expect(decideDrop(view, drop('card-1', 'in_progress', 'todo')).kind).toBe(
      'confirm-stop',
    );
    expect(
      decideDrop(view, drop('card-1', 'in_progress', 'todo'), {
        stopWorker: true,
      }).kind,
    ).toBe('move');
  });

  test('In progress → Finished with a worker running is Mark finished, not a stop', () => {
    const view = boardView([
      card(1, 'in_progress', { round: round('waiting') }),
    ]);
    expect(
      decideDrop(view, drop('card-1', 'in_progress', 'finished')).kind,
    ).toBe('move');
  });

  test('reordering inside a column is a move', () => {
    const view = boardView([card(1, 'todo'), card(2, 'todo')]);
    expect(decideDrop(view, drop('card-1', 'todo', 'todo', 1)).kind).toBe(
      'move',
    );
  });

  test('an unknown card or column is ignored', () => {
    const view = boardView([card(1, 'todo')]);
    expect(decideDrop(view, drop('nope', 'todo', 'finished')).kind).toBe(
      'ignore',
    );
    expect(decideDrop(view, drop('card-1', 'todo', 'archive')).kind).toBe(
      'ignore',
    );
  });

  test('a drop onto the Inbox is refused (#244 D9)', () => {
    const view = boardView([card(1, 'todo')]);
    expect(decideDrop(view, drop('card-1', 'todo', 'inbox')).kind).toBe(
      'refused',
    );
  });

  test('Inbox → To Do is a plain move: the server reads it as Accept', () => {
    const view = boardView([card(1, 'inbox', { source: 'captured' })]);
    const decision = decideDrop(view, drop('card-1', 'inbox', 'todo'));
    expect(decision.kind).toBe('move');
  });

  test('Inbox → Finished or In progress is refused with the Inbox sentence', () => {
    const view = boardView([card(1, 'inbox', { source: 'captured' })]);
    for (const to of ['finished', 'in_progress', 'completed']) {
      const decision = decideDrop(view, drop('card-1', 'inbox', to));
      expect(decision.kind).toBe('refused');
      if (decision.kind === 'refused') {
        expect(decision.error).toBe('invalid_move');
        expect(decision.text).toContain('Inbox');
      }
    }
  });
});

describe('moveRequest', () => {
  test('carries the column and the index; stopWorker only when set', () => {
    const move = drop('card-1', 'todo', 'finished', 2);
    expect(moveRequest(move)).toEqual({ column: 'finished', index: 2 });
    expect(moveRequest(move, true)).toEqual({
      column: 'finished',
      index: 2,
      stopWorker: true,
    });
  });

  test('carries confirmUnlanded only when set (#847)', () => {
    const move = drop('card-1', 'finished', 'completed', 0);
    expect(moveRequest(move)).toEqual({ column: 'completed', index: 0 });
    expect(moveRequest(move, false, true)).toEqual({
      column: 'completed',
      index: 0,
      confirmUnlanded: true,
    });
  });
});
