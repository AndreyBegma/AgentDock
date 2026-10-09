import { describe, expect, test } from 'bun:test';
import { ApiError } from '../api';
import {
  COMMAND_UNAVAILABLE_TEXT,
  describeApprovalError,
  formatDiffStat,
  isCommandUnavailable,
  mismatchSentence,
  movedHead,
  navLabel,
  noteBytes,
  noteError,
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

describe('navLabel', () => {
  test('shows the count only while PRs wait', () => {
    expect(navLabel('Approvals', 0)).toBe('Approvals');
    expect(navLabel('Approvals', 3)).toBe('Approvals · 3');
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

  test('AgentDock on, config off: the orchestrator merges on its own', () => {
    expect(
      mismatchSentence({ agentdock: true, config: false }, true),
    ).toContain('merge on its own');
  });

  test('AgentDock on, config unread: says so', () => {
    expect(mismatchSentence({ agentdock: true, config: null }, true)).toContain(
      'could not be read',
    );
  });

  test('config on, AgentDock off: the reverse', () => {
    expect(
      mismatchSentence({ agentdock: false, config: true }, true),
    ).toContain('AgentDock’s merge approval is off');
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
