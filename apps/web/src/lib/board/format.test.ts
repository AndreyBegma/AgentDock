import { describe, expect, test } from 'bun:test';
import { boardView, card, round } from './fixtures';
import {
  canAccept,
  canGiveFeedback,
  canMarkFinished,
  canRetry,
  canRun,
  canStop,
  cardByNumber,
  columnsOf,
  parseCardParam,
  parseMaxRunning,
  roundPill,
  toItem,
} from './format';

describe('roundPill', () => {
  test('none before the first Run and for a finished round', () => {
    expect(roundPill(null)).toBeNull();
    expect(roundPill(round('finished'))).toBeNull();
  });

  test('waiting is the one that asks for the person', () => {
    expect(roundPill(round('waiting'))).toEqual({
      status: 'waiting',
      label: 'Waiting for you',
    });
    expect(roundPill(round('failed'))?.status).toBe('error');
    expect(roundPill(round('cancelled'))?.label).toBe('Stopped');
  });
});

describe('what a card offers', () => {
  test('To Do can run, never be accepted or sent back', () => {
    const c = card(1, 'todo');
    expect(canRun(c)).toBe(true);
    expect(canAccept(c)).toBe(false);
    expect(canGiveFeedback(c)).toBe(false);
  });

  test('a running card can be stopped or marked finished, not run again', () => {
    const c = card(1, 'in_progress', { round: round('running') });
    expect(canStop(c)).toBe(true);
    expect(canMarkFinished(c)).toBe(true);
    expect(canRun(c)).toBe(false);
    expect(canRetry(c)).toBe(false);
  });

  test('a failed round in In progress is a retry', () => {
    const c = card(1, 'in_progress', { round: round('failed') });
    expect(canRetry(c)).toBe(true);
    expect(canStop(c)).toBe(false);
  });

  test('Finished can be accepted, sent back or run again', () => {
    const c = card(1, 'finished', { round: round('finished') });
    expect(canAccept(c)).toBe(true);
    expect(canGiveFeedback(c)).toBe(true);
    expect(canRun(c)).toBe(true);
  });
});

describe('the view', () => {
  test('columnsOf keeps the four columns in order, even when one is missing', () => {
    const view = boardView([card(1, 'todo')]);
    view.columns = view.columns.filter((c) => c.column !== 'finished');
    expect(columnsOf(view).map((c) => c.column)).toEqual([
      'todo',
      'in_progress',
      'finished',
      'completed',
    ]);
  });

  test('a card reaches the Board with a readable accessible name', () => {
    expect(toItem(card(12, 'todo', { title: 'Dark mode' })).label).toBe(
      'C-12 Dark mode',
    );
  });

  test('cardByNumber finds a card in any column', () => {
    const view = boardView([card(1, 'todo'), card(2, 'completed')]);
    expect(cardByNumber(view, 2)?.id).toBe('card-2');
    expect(cardByNumber(view, 9)).toBeUndefined();
  });
});

describe('parsers', () => {
  test('?card= is a positive whole number or nothing', () => {
    expect(parseCardParam('12')).toBe(12);
    expect(parseCardParam('0')).toBeUndefined();
    expect(parseCardParam('-3')).toBeUndefined();
    expect(parseCardParam('1e3')).toBeUndefined();
    expect(parseCardParam(null)).toBeUndefined();
  });

  test('workers at once is 1–10', () => {
    expect(parseMaxRunning('3')).toBe(3);
    expect(parseMaxRunning(' 10 ')).toBe(10);
    expect(parseMaxRunning('0')).toBeNull();
    expect(parseMaxRunning('11')).toBeNull();
    expect(parseMaxRunning('2.5')).toBeNull();
    expect(parseMaxRunning('')).toBeNull();
  });
});
