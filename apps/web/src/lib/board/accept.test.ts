import { describe, expect, test } from 'bun:test';
import type { CardMergeOutcome, CardPullRequestView } from '@agentdock/shared';
import { acceptChoice, acceptedMessage, mergeMethodText } from './accept';

const SHA = 'a'.repeat(40);

const pr = (extra: Partial<CardPullRequestView> = {}): CardPullRequestView => ({
  number: 7,
  url: 'https://github.com/o/r/pull/7',
  state: 'open',
  headSha: SHA,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  checks: 'green',
  method: 'squash',
  canMerge: true,
  ...extra,
});

describe('acceptChoice (#273 D10)', () => {
  test('an open PR the runner can merge offers both actions, bound to its head', () => {
    expect(acceptChoice(7, pr())).toEqual({ kind: 'merge', headSha: SHA });
  });

  test('a merged PR is “already merged”', () => {
    expect(acceptChoice(7, pr({ state: 'merged', canMerge: false }))).toEqual({
      kind: 'already_merged',
      headSha: SHA,
    });
  });

  test('a closed PR, no PR, an unreadable PR or an old runner is Accept only, with the reason', () => {
    const closed = acceptChoice(7, pr({ state: 'closed', canMerge: false }));
    expect(closed.kind).toBe('accept_only');
    expect(closed).toMatchObject({ reason: expect.stringContaining('closed') });

    const none = acceptChoice(null, null);
    expect(none).toMatchObject({
      kind: 'accept_only',
      reason: expect.stringContaining('no pull request'),
    });

    expect(acceptChoice(7, null).kind).toBe('accept_only');

    const old = acceptChoice(7, pr({ canMerge: false }));
    expect(old).toMatchObject({
      kind: 'accept_only',
      reason: expect.stringContaining('runner'),
    });
  });
});

describe('what the dialog says', () => {
  test('the method, or the repository default', () => {
    expect(mergeMethodText('squash')).toBe('Squash and merge');
    expect(mergeMethodText(null)).toBe('Repository default');
  });

  const outcome = (
    extra: Partial<CardMergeOutcome> = {},
  ): CardMergeOutcome => ({
    merged: true,
    alreadyMerged: false,
    method: 'merge',
    mergeCommit: SHA,
    issueClosed: true,
    branchDeleted: false,
    ...extra,
  });

  test('the toast tells a merge from a plain accept, and warns when the issue stayed open', () => {
    expect(acceptedMessage('C-1', null)).toEqual({
      text: 'C-1 accepted.',
      warn: false,
    });
    expect(acceptedMessage('C-1', outcome()).warn).toBe(false);
    expect(acceptedMessage('C-1', outcome()).text).toMatch(/merged/);
    const open = acceptedMessage(
      'C-1',
      outcome({ issueClosed: false, issueError: 'gh offline' }),
    );
    expect(open.warn).toBe(true);
    expect(open.text).toContain('gh offline');
  });
});
