import { describe, expect, test } from 'bun:test';
import type { CardDependencyRef } from '@agentdock/shared';
import { ApiError } from '../api';
import {
  autoRunNote,
  blockedRunText,
  dependencyChip,
  openDependenciesOf,
  openDependencyText,
  parseCardNumber,
  readinessChip,
  unmergedDependenciesOf,
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

  test('reads the dependencies of a 409 dependencies_unmerged (#636)', () => {
    const refused = new ApiError(409, undefined, 'unmerged', undefined, {
      error: 'dependencies_unmerged',
      dependencies: [ref(3, 'finished'), ref(5, 'finished')],
    });
    expect(unmergedDependenciesOf(refused)).toEqual([
      ref(3, 'finished'),
      ref(5, 'finished'),
    ]);
    expect(openDependenciesOf(refused)).toBeNull();
    const open = new ApiError(409, undefined, 'open', undefined, {
      error: 'dependency_open',
    });
    expect(unmergedDependenciesOf(open)).toBeNull();
  });

  test('says what Run anyway means for an open or an unmerged dependency', () => {
    expect(blockedRunText('C-7', [ref(3, 'todo')], false)).toBe(
      'C-3 is not completed yet. C-7 was meant to run after it, so its worker may miss that work.',
    );
    expect(
      blockedRunText('C-7', [ref(3, 'finished'), ref(5, 'finished')], true),
    ).toBe(
      'C-3 and C-5 are not merged yet, and a card branches from one dependency only. C-7 would start from the project base without their work.',
    );
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

describe('readiness (#443)', () => {
  test('Ready when every dependency is accepted', () => {
    expect(readinessChip(null)).toBeNull();
    expect(readinessChip(undefined)).toBeNull();
    expect(
      readinessChip({ state: 'ready', accepted: 2, total: 2, open: [] }),
    ).toMatchObject({ text: 'Ready', tone: 'ok', waitsFor: null });
  });

  test('Waiting names the open ones', () => {
    const chip = readinessChip({
      state: 'waiting',
      accepted: 1,
      total: 3,
      open: [ref(84, 'in_progress'), ref(86, 'todo')],
    });
    expect(chip).toEqual({
      text: 'Waiting · 1 of 3',
      tone: 'warn',
      title: 'Waits for C-84 and C-86. 1 of 3 accepted.',
      waitsFor: 'Waits for C-84 and C-86',
    });
  });

  test('the Auto-run note says what will start the card', () => {
    const waiting = {
      state: 'waiting' as const,
      accepted: 1,
      total: 2,
      open: [ref(84, 'in_progress')],
    };
    expect(autoRunNote(true, waiting)).toBe(
      'Will start automatically after C-84 is accepted.',
    );
    expect(autoRunNote(false, waiting)).toBe(
      'Nothing starts on its own. Press Run when you are ready.',
    );
    expect(
      autoRunNote(true, { state: 'ready', accepted: 2, total: 2, open: [] }),
    ).toContain('Press Run');
  });
});
