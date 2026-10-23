import { describe, expect, it } from 'bun:test';
import { LOCAL_BOARD_WAIT_CURSOR_MAX } from '../protocol/local';
import type { PendingQuestion } from '../session-message/contracts';
import {
  type BoardWatchCard,
  decodeBoardWaitCursor,
  diffBoardWatch,
  encodeBoardWaitCursor,
} from './session-board';

const PROJECT = 'cm1project0000000000000';

const card = (over: Partial<BoardWatchCard> = {}): BoardWatchCard => ({
  number: 1,
  label: 'C-1',
  title: 'Fix login',
  column: 'todo',
  round: null,
  roundPhase: null,
  ciState: 'none',
  merged: false,
  prNumber: null,
  question: null,
  ...over,
});

const question: PendingQuestion = {
  key: '0123456789abcdef',
  header: null,
  text: 'Which store?',
  options: [
    { index: 1, label: 'Postgres' },
    { index: 2, label: 'Redis' },
  ],
  other: true,
};

const snapshotOf = (cards: BoardWatchCard[]) => {
  const snapshot = decodeBoardWaitCursor(
    encodeBoardWaitCursor(PROJECT, cards),
    PROJECT,
  );
  if (!snapshot) throw new Error('cursor did not decode');
  return snapshot;
};

describe('the board.wait cursor (#845 D8)', () => {
  it('round-trips every watched field', () => {
    const cards = [
      card(),
      card({
        number: 7,
        label: 'C-7',
        column: 'in_progress',
        round: 2,
        roundPhase: 'waiting',
        ciState: 'red',
        merged: true,
        question,
      }),
    ];
    const snapshot = snapshotOf(cards);
    expect(snapshot.cards.get(7)).toEqual({
      column: 'in_progress',
      round: 2,
      roundPhase: 'waiting',
      ciState: 'red',
      merged: true,
      questionKey: question.key,
    });
    expect(diffBoardWatch(snapshot, cards)).toEqual([]);
  });

  it('refuses another project, another version and garbage', () => {
    const cursor = encodeBoardWaitCursor(PROJECT, [card()]);
    expect(decodeBoardWaitCursor(cursor, 'cm1other')).toBeNull();
    expect(decodeBoardWaitCursor(`b0${cursor.slice(2)}`, PROJECT)).toBeNull();
    expect(decodeBoardWaitCursor('nonsense', PROJECT)).toBeNull();
    expect(
      decodeBoardWaitCursor(`b1.${PROJECT}.1,9,,,0,0,`, PROJECT),
    ).toBeNull();
    expect(
      decodeBoardWaitCursor(`b1.${PROJECT}.1,1,,,0,0,;1,1,,,0,0,`, PROJECT),
    ).toBeNull();
  });

  it('keeps an empty board', () => {
    const snapshot = snapshotOf([]);
    expect(snapshot.cards.size).toBe(0);
  });

  it('stays below the cap for a thousand open cards', () => {
    const cards = Array.from({ length: 1_000 }, (_, i) =>
      card({
        number: 10_000 + i,
        column: 'in_progress',
        round: 3,
        roundPhase: 'running',
        ciState: 'pending',
      }),
    );
    expect(encodeBoardWaitCursor(PROJECT, cards).length).toBeLessThan(
      LOCAL_BOARD_WAIT_CURSOR_MAX,
    );
  });
});

describe('diffBoardWatch (#845 D8)', () => {
  it('reports a column change', () => {
    const prior = snapshotOf([card()]);
    expect(diffBoardWatch(prior, [card({ column: 'in_progress' })])).toEqual([
      {
        type: 'column',
        card: 1,
        label: 'C-1',
        title: 'Fix login',
        from: 'todo',
        to: 'in_progress',
      },
    ]);
  });

  it('reports the same changes for the same cursor twice', () => {
    const prior = snapshotOf([card()]);
    const now = [card({ column: 'finished', ciState: 'green' })];
    expect(diffBoardWatch(prior, now)).toEqual(diffBoardWatch(prior, now));
    expect(diffBoardWatch(prior, now)).toHaveLength(2);
  });

  it('reports a round that ended, with its phase', () => {
    const running = card({
      column: 'in_progress',
      round: 1,
      roundPhase: 'running',
    });
    const prior = snapshotOf([running]);
    expect(
      diffBoardWatch(prior, [
        { ...running, column: 'finished', roundPhase: 'finished' },
      ]).map((e) => (e.type === 'round_ended' ? [e.round, e.phase] : e.type)),
    ).toEqual(['column', [1, 'finished']]);
  });

  it('reports a round that ended while a newer one already started', () => {
    const prior = snapshotOf([card({ round: 1, roundPhase: 'running' })]);
    const events = diffBoardWatch(prior, [
      card({ round: 2, roundPhase: 'running' }),
    ]);
    expect(events).toEqual([
      {
        type: 'round_ended',
        card: 1,
        label: 'C-1',
        title: 'Fix login',
        round: 1,
        phase: null,
      },
    ]);
  });

  it('says nothing of a round that moves between active phases', () => {
    const prior = snapshotOf([card({ round: 1, roundPhase: 'running' })]);
    expect(
      diffBoardWatch(prior, [card({ round: 1, roundPhase: 'background' })]),
    ).toEqual([]);
  });

  it('reports CI, a merge and a question', () => {
    const prior = snapshotOf([card({ ciState: 'pending', prNumber: 9 })]);
    const events = diffBoardWatch(prior, [
      card({ ciState: 'red', prNumber: 9, merged: true, question }),
    ]);
    expect(events.map((e) => e.type)).toEqual(['ci', 'pr_merged', 'question']);
    expect(events[1]).toMatchObject({ prNumber: 9 });
    expect(events[2]).toMatchObject({ question });
  });

  it('reports a question once, and a new screen of it again', () => {
    const prior = snapshotOf([card({ question })]);
    expect(diffBoardWatch(prior, [card({ question })])).toEqual([]);
    const next = { ...question, key: 'fedcba9876543210' };
    expect(
      diffBoardWatch(prior, [card({ question: next })]).map((e) => e.type),
    ).toEqual(['question']);
  });

  it('reports a card that appeared and one that was deleted', () => {
    const prior = snapshotOf([card({ number: 4, label: 'C-4' })]);
    const events = diffBoardWatch(prior, [
      card({ number: 2, label: 'C-2', question }),
    ]);
    expect(events).toEqual([
      {
        type: 'column',
        card: 2,
        label: 'C-2',
        title: 'Fix login',
        from: null,
        to: 'todo',
      },
      { type: 'question', card: 2, label: 'C-2', title: 'Fix login', question },
      {
        type: 'column',
        card: 4,
        label: 'C-4',
        title: '',
        from: 'todo',
        to: null,
      },
    ]);
  });
});
