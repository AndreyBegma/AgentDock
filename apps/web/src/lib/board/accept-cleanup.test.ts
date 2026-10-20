import { describe, expect, test } from 'bun:test';
import type { CardMergeOutcome, CardPrCloseOutcome } from '@nautelle/shared';
import {
  acceptedMessage,
  branchCleanupGate,
  defaultAcceptOptions,
  deleteBranchControl,
  mergeRequest,
  noMergeRequest,
} from './accept';

const SHA = 'a'.repeat(40);
const manual = { source: 'manual' } as const;
const terminal = { source: 'terminal' } as const;
const advert = (commands: string[], disabled: string[] = []) =>
  ({ commands, disabled }) as Parameters<typeof branchCleanupGate>[0];

describe('branchCleanupGate (#329 D9)', () => {
  test('a runner that advertises card.prClose is ok', () => {
    expect(branchCleanupGate(advert(['card.merge', 'card.prClose']))).toBe(
      'ok',
    );
  });
  test('missing is outdated, switched off is disabled, no advert is ok', () => {
    expect(branchCleanupGate(advert(['card.merge']))).toBe('outdated');
    expect(branchCleanupGate(advert(['card.prClose'], ['card.prClose']))).toBe(
      'disabled',
    );
    expect(branchCleanupGate(null)).toBe('ok');
  });
});

describe('Delete the branch (#329 D7)', () => {
  test('checked by default, and sent with the merge', () => {
    const options = defaultAcceptOptions(manual);
    expect(deleteBranchControl(manual, options, 'ok')).toMatchObject({
      checked: true,
      disabled: false,
    });
    expect(mergeRequest(manual, SHA, options, 'ok')).toEqual({
      merge: { headSha: SHA, deleteBranch: true },
    });
  });

  test('unchecking it sends no deleteBranch', () => {
    const options = { ...defaultAcceptOptions(manual), deleteBranch: false };
    expect(mergeRequest(manual, SHA, options, 'ok')).toEqual({
      merge: { headSha: SHA },
    });
  });

  test('a terminal card is unchecked and disabled, and never sends it', () => {
    const options = defaultAcceptOptions(terminal);
    expect(options.deleteBranch).toBe(false);
    expect(
      deleteBranchControl(terminal, { ...options, deleteBranch: true }, 'ok'),
    ).toMatchObject({ checked: false, disabled: true });
    expect(
      mergeRequest(terminal, SHA, { ...options, deleteBranch: true }, 'ok'),
    ).toEqual({ merge: { headSha: SHA } });
  });

  test('an old runner is never sent deleteBranch, and says why', () => {
    const options = defaultAcceptOptions(manual);
    expect(deleteBranchControl(manual, options, 'outdated')).toMatchObject({
      checked: false,
      disabled: true,
      hint: expect.stringContaining('Update the runner'),
    });
    expect(mergeRequest(manual, SHA, options, 'outdated')).toEqual({
      merge: { headSha: SHA },
    });
  });
});

describe('Accept without merging (#329 D8)', () => {
  test('Leave the PR open (the default) sends nothing to GitHub', () => {
    expect(noMergeRequest(manual, defaultAcceptOptions(manual), 'ok')).toEqual(
      {},
    );
  });

  test('Close the PR sends closePr with the branch and the issue choice', () => {
    const options = {
      ...defaultAcceptOptions(manual),
      closePr: true,
      closeIssue: true,
    };
    expect(noMergeRequest(manual, options, 'ok')).toEqual({
      closePr: { deleteBranch: true, closeIssue: true },
    });
    expect(
      noMergeRequest(manual, { ...options, closeIssue: false }, 'ok'),
    ).toEqual({ closePr: { deleteBranch: true, closeIssue: false } });
  });

  test('a terminal card closes the PR but keeps its branch', () => {
    const options = { ...defaultAcceptOptions(terminal), closePr: true };
    expect(noMergeRequest(terminal, options, 'ok')).toEqual({
      closePr: { deleteBranch: false, closeIssue: false },
    });
  });

  test('an old runner is never sent closePr', () => {
    const options = { ...defaultAcceptOptions(manual), closePr: true };
    expect(noMergeRequest(manual, options, 'outdated')).toEqual({});
  });
});

describe('acceptedMessage with cleanup (#329)', () => {
  const merged = (extra: Partial<CardMergeOutcome> = {}): CardMergeOutcome => ({
    merged: true,
    alreadyMerged: false,
    method: 'squash',
    mergeCommit: 'abc',
    issueClosed: true,
    branchDeleted: true,
    ...extra,
  });
  const closed = (
    extra: Partial<CardPrCloseOutcome> = {},
  ): CardPrCloseOutcome => ({
    closed: true,
    alreadyClosed: false,
    branchDeleted: true,
    issueClosed: false,
    ...extra,
  });

  test('a merge that deleted the branch says so', () => {
    expect(acceptedMessage('C-1', merged())).toEqual({
      text: 'C-1 accepted and its pull request merged, and its branch deleted.',
      warn: false,
    });
  });

  test('a failed deletion is a warning; the merge stands', () => {
    const message = acceptedMessage(
      'C-1',
      merged({ branchDeleted: false, branchError: 'protected branch' }),
    );
    expect(message.warn).toBe(true);
    expect(message.text).toContain('protected branch');
    expect(message.text).toContain('merged');
  });

  test('a close reports the branch, and warns about what failed', () => {
    expect(acceptedMessage('C-1', null, closed())).toEqual({
      text: 'C-1 accepted and its pull request closed, and its branch deleted.',
      warn: false,
    });
    const warn = acceptedMessage(
      'C-1',
      null,
      closed({ branchDeleted: false, branchError: 'gone', issueError: 'nope' }),
    );
    expect(warn.warn).toBe(true);
    expect(warn.text).toContain('gone');
    expect(warn.text).toContain('nope');
  });
});
