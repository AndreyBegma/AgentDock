import { describe, expect, test } from 'bun:test';
import { card } from './fixtures';
import { takenSessionHref, takenState } from './taken';

describe('takenState', () => {
  test('a card nobody took reads as nothing', () => {
    expect(takenState(card(1, 'todo'))).toBeNull();
  });

  test('a taken card names the session and whether it lives', () => {
    const alive = takenState(
      card(1, 'in_progress', {
        taken: { sessionId: 'abcdef123456', alive: true, branch: null },
      }),
    );
    expect(alive).toEqual({
      kind: 'taken',
      text: 'taken by abcdef12',
      sessionId: 'abcdef123456',
      alive: true,
    });
    const ended = takenState(
      card(1, 'in_progress', {
        taken: { sessionId: 'abcdef123456', alive: false, branch: 'b' },
      }),
    );
    expect(ended).toMatchObject({ kind: 'taken', alive: false });
  });

  test('a queued card names the session it waits for', () => {
    expect(
      takenState(card(2, 'todo', { queuedForSessionId: 'zzzzzzzz9999' })),
    ).toEqual({
      kind: 'queued',
      text: 'queued for zzzzzzzz',
      sessionId: 'zzzzzzzz9999',
    });
  });

  test('the session link follows the taking session', () => {
    expect(takenSessionHref(card(1, 'todo'))).toBeNull();
    expect(
      takenSessionHref(
        card(1, 'in_progress', {
          taken: { sessionId: 'abc', alive: true, branch: null },
        }),
      ),
    ).toContain('abc');
  });
});
