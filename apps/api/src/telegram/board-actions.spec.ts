import type { BoardCardDetail } from '@nautelle/shared';
import {
  BOARD_CALLBACK_PREFIXES,
  boardFailureText,
  cardKeyboard,
  cardText,
  parseCardNumber,
  parseColumn,
} from './board-actions';

const card = (over: Partial<BoardCardDetail> = {}) =>
  ({
    id: 'c1',
    number: 7,
    label: 'C-7',
    title: 'Add login',
    kind: 'feature',
    column: 'todo',
    source: 'manual',
    tracking: null,
    round: null,
    design: null,
    prNumber: null,
    prState: null,
    ciState: 'none',
    body: '',
    ...over,
  }) as BoardCardDetail;

describe('board actions', () => {
  it('reads a card number in the forms people type', () => {
    expect(parseCardNumber('12')).toBe(12);
    expect(parseCardNumber('C-12')).toBe(12);
    expect(parseCardNumber('c12')).toBe(12);
    expect(parseCardNumber('#12')).toBe(12);
    for (const bad of ['', '0', 'abc', '12 13', '1234567890', '-3']) {
      expect(parseCardNumber(bad)).toBeNull();
    }
  });

  it('reads a column by key or title', () => {
    expect(parseColumn('todo')).toBe('todo');
    expect(parseColumn('To Do')).toBe('todo');
    expect(parseColumn('in progress')).toBe('in_progress');
    expect(parseColumn('in-progress')).toBe('in_progress');
    expect(parseColumn('done')).toBeNull();
  });

  it('claims eight distinct prefixes, none of them a legacy one', () => {
    expect(new Set(BOARD_CALLBACK_PREFIXES).size).toBe(8);
  });

  it('shows the pull request and the agent state on the detail', () => {
    const text = cardText(
      card({
        column: 'in_progress',
        round: { round: 2, phase: 'running' } as BoardCardDetail['round'],
        prNumber: 34,
        prState: 'open',
        ciState: 'green',
      }),
    );
    expect(text).toContain('Agent: Running (round 2)');
    expect(text).toContain('Pull request: #34 open · checks green');
  });

  it('offers the write buttons the web offers, and none to a reader', () => {
    const labelsOf = (keyboard: ReturnType<typeof cardKeyboard>) =>
      keyboard.flat().map((b) => b.text);
    expect(labelsOf(cardKeyboard('p1', card(), true, null))).toEqual([
      'Move',
      'Run',
      '‹ To Do',
    ]);
    expect(
      labelsOf(
        cardKeyboard(
          'p1',
          card({
            column: 'in_progress',
            round: { round: 1, phase: 'running' } as BoardCardDetail['round'],
          }),
          true,
          'https://dock.example.com',
        ),
      ),
    ).toEqual(['Move', 'Stop', 'Open in app', '‹ In progress']);
    expect(labelsOf(cardKeyboard('p1', card(), false, null))).toEqual([
      '‹ To Do',
    ]);
  });

  it('opens the card in the Mini App over https, else by its plain link (#580)', () => {
    const openOf = (appUrl: string) =>
      cardKeyboard('p1', card(), false, appUrl)
        .flat()
        .find((b) => b.text === 'Open in app');
    expect(openOf('https://dock.example.com')).toEqual({
      text: 'Open in app',
      web_app: { url: `https://dock.example.com/tg?start=p1_${card().number}` },
    });
    expect(openOf('http://localhost:3517')).toEqual({
      text: 'Open in app',
      url: `http://localhost:3517/projects/p1/board/cards/${card().number}`,
    });
  });

  it('words the board’s refusals as the web does', () => {
    expect(boardFailureText('move_refused', 'fleet_slot', 'x')).toMatch(
      /follows its slot/,
    );
    expect(boardFailureText('move_refused', 'unknown', 'x')).toBe(
      'That move is not allowed.',
    );
    expect(boardFailureText('max_running', undefined, 'x')).toMatch(/limit/);
    expect(boardFailureText(null, undefined, 'Something odd')).toBe(
      'Something odd',
    );
  });
});
