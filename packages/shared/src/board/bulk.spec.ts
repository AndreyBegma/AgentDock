import { describe, expect, it } from 'bun:test';
import { type BulkCardFacts, bulkCardRule } from './bulk';

const card = (facts: Partial<BulkCardFacts>): BulkCardFacts => ({
  column: 'finished',
  roundPhase: 'finished',
  source: 'manual',
  autoCollect: false,
  slotGone: false,
  ...facts,
});

const reason = (
  action: Parameters<typeof bulkCardRule>[0],
  facts: Partial<BulkCardFacts>,
) => {
  const decision = bulkCardRule(action, card(facts));
  return decision.applies ? null : decision.reason;
};

describe('bulkCardRule', () => {
  it('completes a Finished card, also a fleet card', () => {
    expect(reason('complete', {})).toBeNull();
    expect(reason('complete', { source: 'fleet' })).toBeNull();
  });

  it('completes only from Finished', () => {
    expect(reason('complete', { column: 'todo', roundPhase: null })).toBe(
      'wrong_column',
    );
    expect(reason('complete', { column: 'completed' })).toBe(
      'already_in_column',
    );
  });

  it('moves a Finished card back to To Do, never a fleet card with a live slot', () => {
    expect(reason('todo', {})).toBeNull();
    expect(reason('todo', { source: 'fleet' })).toBe('fleet_slot');
    expect(reason('todo', { source: 'fleet', slotGone: true })).toBeNull();
    expect(reason('todo', { column: 'todo', roundPhase: null })).toBe(
      'already_in_column',
    );
  });

  it('holds a running card in In progress except for Mark finished', () => {
    const running = { column: 'in_progress', roundPhase: 'running' } as const;
    expect(reason('todo', running)).toBe('card_running');
    expect(reason('complete', running)).toBe('wrong_column');
    expect(reason('delete', running)).toBe('card_running');
    expect(reason('finished', running)).toBeNull();
  });

  it('marks finished only a card with a worker', () => {
    expect(reason('finished', { column: 'todo', roundPhase: null })).toBe(
      'not_running',
    );
  });

  it('deletes any card that is not running', () => {
    expect(reason('delete', { column: 'completed' })).toBeNull();
    expect(reason('delete', { column: 'todo', roundPhase: null })).toBeNull();
  });

  it('leaves the Inbox alone', () => {
    for (const action of ['complete', 'todo', 'finished', 'delete'] as const) {
      expect(reason(action, { column: 'inbox', roundPhase: null })).toBe(
        'invalid_move',
      );
    }
  });
});
