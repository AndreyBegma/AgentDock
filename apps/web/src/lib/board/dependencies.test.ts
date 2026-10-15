import { describe, expect, test } from 'bun:test';
import type { CardDependencyRef } from '@agentdock/shared';
import { ApiError } from '../api';
import {
  dependencyChip,
  openDependenciesOf,
  openDependencyText,
  parseCardNumber,
} from './dependencies';

const ref = (
  number: number,
  column: CardDependencyRef['column'],
): CardDependencyRef => ({ number, label: `C-${number}`, column });

describe('card dependencies (#337 D8)', () => {
  test('the face says "after C-12", and warns while it is open', () => {
    expect(dependencyChip(undefined)).toBeNull();
    expect(dependencyChip([])).toBeNull();
    const chip = dependencyChip([ref(12, 'todo')]);
    expect(chip?.text).toBe('after C-12');
    expect(chip?.open).toBe(true);
    expect(chip?.title).toBe('Runs after C-12. Not completed yet: C-12.');
    expect(dependencyChip([ref(12, 'completed')])?.open).toBe(false);
  });

  test('more than two dependencies are counted', () => {
    const chip = dependencyChip([
      ref(3, 'completed'),
      ref(5, 'completed'),
      ref(9, 'in_progress'),
    ]);
    expect(chip?.text).toBe('after C-3, C-5 +1');
    expect(chip?.title).toBe(
      'Runs after C-3, C-5, C-9. Not completed yet: C-9.',
    );
  });

  test('Run asks with the open ones named', () => {
    expect(openDependencyText([ref(12, 'todo')])).toBe(
      'C-12 is not completed yet.',
    );
    expect(
      openDependencyText([ref(3, 'todo'), ref(5, 'finished'), ref(9, 'todo')]),
    ).toBe('C-3, C-5 and C-9 are not completed yet.');
    expect(openDependencyText([])).toBe('A dependency is not completed yet.');
  });

  test('reads the open dependencies of a 409 dependency_open', () => {
    const refused = new ApiError(409, undefined, 'open', undefined, {
      error: 'dependency_open',
      dependencies: [ref(12, 'todo'), { junk: true }],
    });
    expect(openDependenciesOf(refused)).toEqual([ref(12, 'todo')]);
    const bare = new ApiError(409, undefined, 'open', undefined, {
      error: 'dependency_open',
    });
    expect(openDependenciesOf(bare)).toEqual([]);
    const other = new ApiError(409, undefined, 'busy', undefined, {
      error: 'card_running',
    });
    expect(openDependenciesOf(other)).toBeNull();
    expect(openDependenciesOf(new Error('x'))).toBeNull();
  });

  test('the add field takes 12 or C-12', () => {
    expect(parseCardNumber('12')).toBe(12);
    expect(parseCardNumber(' C-12 ')).toBe(12);
    expect(parseCardNumber('c12')).toBe(12);
    expect(parseCardNumber('0')).toBeNull();
    expect(parseCardNumber('twelve')).toBeNull();
    expect(parseCardNumber('')).toBeNull();
  });
});
