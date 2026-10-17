import { describe, expect, test } from 'bun:test';
import { cardLabelOf } from './tools';

describe('cardLabelOf', () => {
  test('reads the card from a queue step', () => {
    expect(cardLabelOf('Queued C-12 in To Do')).toEqual({
      label: 'C-12',
      number: 12,
    });
  });

  test('is null when the summary names no card', () => {
    expect(cardLabelOf('Read the Alpha Board — 4 cards')).toBeNull();
    expect(cardLabelOf('Queued ABC-12')).toBeNull();
  });
});
