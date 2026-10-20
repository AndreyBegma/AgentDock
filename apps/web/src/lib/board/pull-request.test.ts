import { describe, expect, test } from 'bun:test';
import {
  canCreatePr,
  collectMessage,
  noPrText,
  prChipText,
  prTargetNotice,
  prTargetText,
} from './pull-request';

describe('prTargetText (#636)', () => {
  test('names the dependency a stacked PR goes into, else the base', () => {
    expect(prTargetText(null)).toBeNull();
    expect(prTargetText({ branch: 'develop', stackedOn: null })).toBe(
      'into develop',
    );
    expect(
      prTargetText({
        branch: 'feat/1-login',
        stackedOn: { number: 1, label: 'C-1', merged: false },
      }),
    ).toBe('into C-1’s branch');
  });
});

describe('prTargetNotice (#709)', () => {
  const stacked = (merged: boolean) => ({
    branch: 'feat/1-login',
    stackedOn: { number: 1, label: 'C-1', merged },
  });

  test('nothing for a PR into the base', () => {
    expect(prTargetNotice(null)).toBeNull();
    expect(prTargetNotice({ branch: 'develop', stackedOn: null })).toBeNull();
  });

  test('names the dependency branch a stacked PR goes into', () => {
    expect(prTargetNotice(stacked(false))).toEqual({
      tone: 'info',
      text: 'The pull request goes into C-1’s branch (feat/1-login), not the base. Its work reaches the base when C-1’s pull request merges.',
    });
  });

  test('warns once the dependency’s own PR has merged', () => {
    const notice = prTargetNotice(stacked(true));
    expect(notice?.tone).toBe('warn');
    expect(notice?.text).toContain('C-1’s own pull request has already merged');
    expect(notice?.text).toContain('retarget it on GitHub');
  });
});

describe('prChipText (#329 D6)', () => {
  test('shows the number in every column, with the state when known', () => {
    expect(prChipText({ prNumber: 7, prState: null })).toBe('PR #7');
    expect(prChipText({ prNumber: 7, prState: 'open' })).toBe('PR #7 · Open');
    expect(prChipText({ prNumber: 7, prState: 'draft' })).toBe('PR #7 · Draft');
    expect(prChipText({ prNumber: 7, prState: 'merged' })).toBe(
      'PR #7 · Merged',
    );
    expect(prChipText({ prNumber: 7, prState: 'closed' })).toBe(
      'PR #7 · Closed',
    );
    expect(prChipText({ prNumber: null, prState: null })).toBeNull();
  });
});

describe('canCreatePr (#329 D5)', () => {
  const card = {
    column: 'finished' as const,
    branch: 'card/c-6',
    prUrl: null,
    collectState: 'failed' as const,
  };

  test('offered in Finished and Completed with a branch and no PR', () => {
    expect(canCreatePr(card)).toBe(true);
    expect(canCreatePr({ ...card, column: 'completed' })).toBe(true);
    expect(canCreatePr({ ...card, collectState: 'none' })).toBe(true);
  });

  test('not offered elsewhere, without a branch, with a PR, or for no_changes', () => {
    expect(canCreatePr({ ...card, column: 'in_progress' })).toBe(false);
    expect(canCreatePr({ ...card, column: 'todo' })).toBe(false);
    expect(canCreatePr({ ...card, branch: null })).toBe(false);
    expect(
      canCreatePr({ ...card, prUrl: 'https://github.com/o/r/pull/1' }),
    ).toBe(false);
    expect(canCreatePr({ ...card, collectState: 'no_changes' })).toBe(false);
  });
});

describe('noPrText', () => {
  test('a failed collect says why', () => {
    expect(
      noPrText({ collectState: 'failed', collectError: 'push rejected' }),
    ).toEqual({ tone: 'warn', text: 'No pull request: push rejected' });
  });

  test('other states are plain', () => {
    expect(noPrText({ collectState: 'none', collectError: null }).tone).toBe(
      'info',
    );
    expect(noPrText({ collectState: 'pending', collectError: null }).text).toBe(
      'Opening the pull request…',
    );
  });
});

describe('collectMessage', () => {
  test('ok, no_changes and failed', () => {
    expect(
      collectMessage('C-6', {
        state: 'ok',
        error: null,
        ahead: 3,
        prNumber: 9,
        prUrl: 'https://github.com/o/r/pull/9',
      }),
    ).toMatchObject({ ok: true, text: expect.stringContaining('#9') });
    expect(
      collectMessage('C-6', {
        state: 'no_changes',
        error: null,
        ahead: 0,
        prNumber: null,
        prUrl: null,
      }).ok,
    ).toBe(true);
    expect(
      collectMessage('C-6', {
        state: 'failed',
        error: 'auth failed',
        ahead: null,
        prNumber: null,
        prUrl: null,
      }),
    ).toEqual({ ok: false, text: 'No pull request for C-6: auth failed' });
  });
});
