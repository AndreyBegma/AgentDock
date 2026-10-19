import { describe, expect, it } from 'bun:test';
import {
  BOARD_ERROR,
  cardReadiness,
  findDependencyCycle,
  isDependencySatisfied,
  openDependencies,
} from '../index';

/** #337 D8: card dependencies. */

describe('findDependencyCycle', () => {
  const edges = [
    { cardId: 'b', dependsOnId: 'a' },
    { cardId: 'c', dependsOnId: 'b' },
    { cardId: 'd', dependsOnId: 'a' },
  ];

  it('allows a link that closes no cycle', () => {
    expect(findDependencyCycle(edges, 'd', 'c')).toBeNull();
    expect(findDependencyCycle(edges, 'c', 'a')).toBeNull();
    expect(findDependencyCycle([], 'a', 'b')).toBeNull();
  });

  it('refuses a card depending on itself', () => {
    expect(findDependencyCycle(edges, 'a', 'a')).toEqual(['a', 'a']);
  });

  it('refuses a link that closes a cycle, naming it', () => {
    expect(findDependencyCycle(edges, 'a', 'b')).toEqual(['a', 'b', 'a']);
    expect(findDependencyCycle(edges, 'a', 'c')).toEqual(['a', 'c', 'b', 'a']);
  });
});

describe('isDependencySatisfied', () => {
  it('is Finished (a ready PR) or Completed (#638)', () => {
    expect(isDependencySatisfied('finished')).toBe(true);
    expect(isDependencySatisfied('completed')).toBe(true);
    expect(isDependencySatisfied('todo')).toBe(false);
    expect(isDependencySatisfied('in_progress')).toBe(false);
    expect(isDependencySatisfied('inbox')).toBe(false);
  });
});

describe('openDependencies', () => {
  it('is every dependency not in Finished or Completed', () => {
    const deps = [
      { number: 12, label: 'C-12', column: 'todo' as const },
      { number: 13, label: 'C-13', column: 'completed' as const },
      { number: 14, label: 'C-14', column: 'finished' as const },
      { number: 15, label: 'C-15', column: 'in_progress' as const },
    ];
    expect(openDependencies(deps).map((d) => d.number)).toEqual([12, 15]);
  });
});

describe('cardReadiness', () => {
  const accepted = { number: 83, label: 'C-83', column: 'completed' as const };
  const open = { number: 84, label: 'C-84', column: 'in_progress' as const };
  const finished = { number: 85, label: 'C-85', column: 'finished' as const };

  it('is ready when every dependency is in Finished or Completed', () => {
    expect(cardReadiness('todo', [accepted, finished])).toEqual({
      state: 'ready',
      satisfied: 2,
      total: 2,
      open: [],
    });
  });

  it('is waiting while one is open, naming the open ones', () => {
    expect(cardReadiness('todo', [accepted, open])).toEqual({
      state: 'waiting',
      satisfied: 1,
      total: 2,
      open: [open],
    });
  });

  it('is none for a card without dependencies or outside To Do', () => {
    expect(cardReadiness('todo', [])).toBeNull();
    expect(cardReadiness('in_progress', [open])).toBeNull();
    expect(cardReadiness('finished', [accepted])).toBeNull();
  });
});

describe('the board errors', () => {
  it('name the dependency refusals', () => {
    expect(BOARD_ERROR.dependencyOpen).toBe('dependency_open');
    expect(BOARD_ERROR.dependencyCycle).toBe('dependency_cycle');
    expect(BOARD_ERROR.invalidDependency).toBe('invalid_dependency');
  });
});
