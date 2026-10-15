import { describe, expect, test } from 'bun:test';
import { ApiError } from '../api';
import {
  approveAndRun,
  approveConsequence,
  offersApproveAndRun,
} from './design-actions';
import { card } from './fixtures';
import { describeBoardError } from './format';

describe('approveAndRun (#243 D6)', () => {
  test('approves the picked revision, then runs', async () => {
    const calls: string[] = [];
    await approveAndRun(
      {
        approve: async (id) => {
          calls.push(`approve:${id}`);
        },
        run: async () => {
          calls.push('run');
        },
      },
      'rev-2-1',
    );
    expect(calls).toEqual(['approve:rev-2-1', 'run']);
  });

  test('a refused approval never runs the card', async () => {
    const calls: string[] = [];
    await expect(
      approveAndRun(
        {
          approve: async () => {
            throw new Error('design_busy');
          },
          run: async () => {
            calls.push('run');
          },
        },
        'rev-1-1',
      ),
    ).rejects.toThrow('design_busy');
    expect(calls).toEqual([]);
  });

  test('a refused run leaves the approval standing and surfaces the error', async () => {
    const calls: string[] = [];
    await expect(
      approveAndRun(
        {
          approve: async () => {
            calls.push('approve');
          },
          run: async () => {
            throw new Error('max_running');
          },
        },
        'rev-1-1',
      ),
    ).rejects.toThrow('max_running');
    expect(calls).toEqual(['approve']);
  });
});

describe('the board refusals of #243', () => {
  const refused = (error: string) =>
    // As `api()` builds it: the body's `error` is also the error's `code`.
    new ApiError(
      409,
      error as ConstructorParameters<typeof ApiError>[1],
      'raw',
      undefined,
      { error },
    );

  test('Run on an unapproved design and a late switch have their own sentences', () => {
    expect(describeBoardError(refused('design_not_approved'))).toMatch(
      /not approved/,
    );
    expect(describeBoardError(refused('design_approved'))).toMatch(
      /can no longer change/,
    );
  });
});

describe('the switch', () => {
  test('Approve & run is offered only when approval starts nothing', () => {
    expect(offersApproveAndRun(card(1, 'todo'))).toBe(true);
    expect(
      offersApproveAndRun(card(1, 'todo', { continueAfterDesign: true })),
    ).toBe(false);
  });

  test('the dialog says whether the worker starts', () => {
    expect(approveConsequence(true)).toContain('worker starts after approval');
    expect(approveConsequence(false)).toContain('waits in To Do');
  });
});
