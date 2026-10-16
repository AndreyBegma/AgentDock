import { describe, expect, test } from 'bun:test';
import { TERMINAL_HISTORY_LINES } from '@agentdock/shared/protocol';
import {
  HISTORY_SWIPE_PX,
  HistoryController,
  type HistoryView,
  historyText,
  Swipe,
  TouchScroll,
  wheelLines,
} from './history';

const controller = () => {
  const views: HistoryView[] = [];
  return { history: new HistoryController((v) => views.push(v)), views };
};

describe('historyText', () => {
  test('joins as written and resets only at the end, so colours carry on', () => {
    expect(historyText(['\u001b[31mred 1', 'red 2'])).toBe(
      '\u001b[31mred 1\r\nred 2\u001b[0m',
    );
  });
});

describe('HistoryController', () => {
  test('asks once per scroll back, and shows the lines of the last chunk', () => {
    const { history, views } = controller();
    expect(history.scrolledUp()).toBe(true);
    expect(history.scrolledUp()).toBe(false);
    expect(history.received({ lines: ['a', 'b'], last: false })).toBeNull();
    expect(history.received({ lines: ['c'], last: true })).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(history.scrolledUp()).toBe(false);
    expect(views).toEqual(['loading', 'shown']);
  });

  test('back to live asks again on the next scroll back', () => {
    const { history, views } = controller();
    history.scrolledUp();
    history.received({ lines: ['a'], last: true });
    history.live();
    expect(history.scrolledUp()).toBe(true);
    expect(views).toEqual(['loading', 'shown', 'live', 'loading']);
  });

  test('drops chunks that arrive while live or after the answer', () => {
    const { history } = controller();
    expect(history.received({ lines: ['early'], last: true })).toBeNull();
    history.scrolledUp();
    history.live();
    expect(history.received({ lines: ['late'], last: true })).toBeNull();
    history.scrolledUp();
    expect(history.received({ lines: ['x'], last: true })).toEqual(['x']);
    expect(history.received({ lines: ['again'], last: true })).toBeNull();
  });

  test('an empty answer stays live', () => {
    const { history, views } = controller();
    history.scrolledUp();
    expect(history.received({ lines: [], last: true })).toBeNull();
    expect(history.state).toBe('live');
    expect(views).toEqual(['loading', 'live']);
  });

  test('keeps at most 5,000 lines, the newest', () => {
    const { history } = controller();
    history.scrolledUp();
    const lines = Array.from(
      { length: TERMINAL_HISTORY_LINES + 2 },
      (_, i) => `${i}`,
    );
    const shown = history.received({ lines, last: true });
    expect(shown).toHaveLength(TERMINAL_HISTORY_LINES);
    expect(shown?.[0]).toBe('2');
  });
});

describe('Swipe', () => {
  test('answers down or up once the finger travelled far enough', () => {
    const swipe = new Swipe();
    expect(swipe.swipe(100)).toBeNull();
    swipe.start(100);
    expect(swipe.swipe(100 + HISTORY_SWIPE_PX - 1)).toBeNull();
    expect(swipe.swipe(100 + HISTORY_SWIPE_PX)).toBe('down');
    expect(swipe.swipe(100 - HISTORY_SWIPE_PX)).toBe('up');
    swipe.end();
    expect(swipe.swipe(500)).toBeNull();
  });
});

describe('wheelLines', () => {
  test('counts pixels by the cell, lines as lines and pages by rows', () => {
    expect(wheelLines(-100, 0, 20, 30)).toBe(-5);
    expect(wheelLines(3, 1, 20, 30)).toBe(3);
    expect(wheelLines(1, 2, 20, 30)).toBe(30);
  });

  test('a small step still moves one line, and none moves none', () => {
    expect(wheelLines(4, 0, 20, 30)).toBe(1);
    expect(wheelLines(-4, 0, 20, 30)).toBe(-1);
    expect(wheelLines(0, 0, 20, 30)).toBe(0);
  });
});

describe('TouchScroll', () => {
  test('turns finger travel into whole lines and keeps the remainder', () => {
    const touch = new TouchScroll();
    expect(touch.lines(50, 20)).toBe(0);
    touch.start(100);
    expect(touch.lines(130, 20)).toBe(1);
    expect(touch.lines(150, 20)).toBe(1);
    expect(touch.lines(90, 20)).toBe(-3);
    touch.end();
    expect(touch.lines(400, 20)).toBe(0);
  });
});
