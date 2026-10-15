import { describe, expect, it } from 'bun:test';
import { BOARD_ERROR, findDependencyCycle, openDependencies } from '../index';

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

describe('openDependencies', () => {
  it('is every dependency not in Completed', () => {
    const deps = [
      { number: 12, label: 'C-12', column: 'todo' as const },
      { number: 13, label: 'C-13', column: 'completed' as const },
      { number: 14, label: 'C-14', column: 'finished' as const },
    ];
    expect(openDependencies(deps).map((d) => d.number)).toEqual([12, 14]);
  });
});

describe('the board errors', () => {
  it('name the dependency refusals', () => {
    expect(BOARD_ERROR.dependencyOpen).toBe('dependency_open');
    expect(BOARD_ERROR.dependencyCycle).toBe('dependency_cycle');
    expect(BOARD_ERROR.invalidDependency).toBe('invalid_dependency');
  });
});
