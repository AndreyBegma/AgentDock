import { describe, expect, test } from 'bun:test';
import { ApiError } from '../api';
import {
  approvalSettingsHref,
  approvalsBadge,
  COMMAND_UNAVAILABLE_TEXT,
  decisionDisabledReason,
  describeApprovalError,
  describeApprovalHint,
  emptyWaitingCopy,
  formatDiffStat,
  isCommandUnavailable,
  mismatchSentence,
  movedHead,
  noteBytes,
  noteError,
  SOURCE_LABEL,
  SOURCE_TOOLTIP,
} from './format';

const apiError = (
  status: number,
  code: string,
  message = 'm',
  body: Record<string, unknown> = {},
) =>
  new ApiError(status, code as never, message, undefined, {
    error: code,
    ...body,
  });

describe('approvalsBadge', () => {
  test('draws nothing while no PR waits', () => {
    expect(approvalsBadge(0)).toBeUndefined();
  });

  test('counts the waiting PRs and says what the number is', () => {
    expect(approvalsBadge(1)).toEqual({
      count: 1,
      tone: 'warn',
      label: '1 waiting approval',
    });
    expect(approvalsBadge(3)?.label).toBe('3 waiting approvals');
  });
});

describe('formatDiffStat', () => {
  test('adds and deletions', () => {
    expect(formatDiffStat(12, 3)).toBe('+12 −3');
  });
});

describe('noteError', () => {
  test('blank is refused', () => {
    expect(noteError('')).not.toBeNull();
    expect(noteError('  \n ')).not.toBeNull();
  });

  test('a note is allowed up to 4096 UTF-8 bytes', () => {
    expect(noteError('fix the migration')).toBeNull();
    expect(noteError('a'.repeat(4096))).toBeNull();
    expect(noteError('a'.repeat(4097))).not.toBeNull();
  });

  test('counts bytes, not characters', () => {
    expect(noteBytes('я')).toBe(2);
    expect(noteError('я'.repeat(2049))).not.toBeNull();
    expect(noteError('я'.repeat(2048))).toBeNull();
  });
});

describe('mismatchSentence', () => {
  test('silent when the flags agree', () => {
    expect(
      mismatchSentence({ agentdock: true, config: true }, false),
    ).toBeNull();
  });

  test('Nautelle on, config off: the orchestrator merges on its own', () => {
    expect(
      mismatchSentence({ agentdock: true, config: false }, true),
    ).toContain('merge on its own');
  });

  test('Nautelle on, config unread: says so', () => {
    expect(mismatchSentence({ agentdock: true, config: null }, true)).toContain(
      'could not be read',
    );
  });

  test('config on, Nautelle off: the reverse', () => {
    expect(
      mismatchSentence({ agentdock: false, config: true }, true),
    ).toContain('Nautelle’s merge approval is off');
  });
});

describe('empty list and decision reasons', () => {
  test('with approval off the empty state says so', () => {
    expect(emptyWaitingCopy(false).title).toBe('Merge approval is off');
    expect(emptyWaitingCopy(true).title).toBe('Nothing is waiting');
  });

  test('the settings link opens the General tab of this project', () => {
    expect(approvalSettingsHref('p1')).toBe(
      '/projects/p1/settings?tab=general',
    );
  });

  test('no inspection: plain words, the runner named', () => {
    const text = decisionDisabledReason(null, 'laptop');
    expect(text).toContain('runner on laptop');
    expect(text).not.toContain('inspects');
  });

  test('a closed pull request cannot be decided; an open one can', () => {
    expect(decisionDisabledReason({ state: 'closed' })).toContain(
      'no longer open',
    );
    expect(decisionDisabledReason({ state: 'open' })).toBeNull();
  });
});

describe('error mapping', () => {
  test('head_moved carries the new head and says nothing was sent', () => {
    const head = 'a'.repeat(40);
    const error = apiError(409, 'head_moved', 'moved', { headSha: head });
    expect(movedHead(error)).toBe(head);
    expect(describeApprovalError(error)).toContain('Nothing was sent');
  });

  test('other errors have no moved head', () => {
    expect(movedHead(apiError(409, 'not_waiting'))).toBeUndefined();
    expect(movedHead(new Error('x'))).toBeUndefined();
  });

  test('the runner-not-wired seam is recognised and explained', () => {
    const error = apiError(503, 'command_unavailable');
    expect(isCommandUnavailable(error)).toBe(true);
    expect(describeApprovalError(error)).toBe(COMMAND_UNAVAILABLE_TEXT);
  });

  test('a too-old runner points at Runners; other errors carry no link', () => {
    expect(
      describeApprovalHint(apiError(503, 'command_unavailable'), 'build-box'),
    ).toMatchObject({ href: '/admin/runners', cta: 'Open Runners' });
    expect(describeApprovalHint(apiError(409, 'not_waiting'))).toEqual({
      text: describeApprovalError(apiError(409, 'not_waiting')),
    });
  });

  test('an old runner is named and told to update, with no "yet"', () => {
    const text = describeApprovalError(
      apiError(503, 'command_unavailable'),
      'laptop',
    );
    expect(text).toContain('Update the Nautelle runner on laptop');
    expect(text).not.toContain('yet');
  });

  test('inferred, not derived, is what the list says', () => {
    expect(SOURCE_LABEL.derived).toBe('inferred');
    expect(SOURCE_TOOLTIP.derived).toContain('inferred');
  });

  test('the remaining codes map to sentences', () => {
    expect(describeApprovalError(apiError(409, 'not_waiting'))).toContain(
      'no longer waiting',
    );
    expect(describeApprovalError(apiError(409, 'pr_not_open'))).toContain(
      'merged or closed',
    );
    expect(describeApprovalError(apiError(422, 'note_required'))).toContain(
      'worker',
    );
    expect(describeApprovalError(apiError(422, 'note_too_long'))).toContain(
      'KB',
    );
    expect(
      describeApprovalError(apiError(502, 'command_failed', 'boom')),
    ).toContain('boom');
  });

  test('403 and 404 without a code', () => {
    expect(
      describeApprovalError(new ApiError(403, undefined, 'Forbidden')),
    ).toContain('operators');
    expect(
      describeApprovalError(new ApiError(404, undefined, 'Not Found')),
    ).toContain('not a member');
  });
});
