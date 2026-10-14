import { describe, expect, test } from 'bun:test';
import type { ActionRequestSummary } from '@agentdock/shared';
import { ApiError } from '../api';
import {
  describeActionRequestError,
  formatCountdown,
  pendingRequests,
  recentRequests,
  requestTitle,
  resultMessage,
  secondsLeft,
  toolUseArgs,
} from './action-requests';

const row = (over: Partial<ActionRequestSummary>): ActionRequestSummary => ({
  id: 'a',
  projectId: 'p',
  runnerId: 'r',
  sessionId: null,
  requestedById: null,
  kind: 'tool_use',
  summary: '',
  args: { toolName: 'Bash' },
  status: 'pending',
  decidedById: null,
  decidedAt: null,
  note: null,
  expiresAt: '2026-10-14T10:05:00.000Z',
  createdAt: '2026-10-14T10:00:00.000Z',
  ...over,
});

describe('secondsLeft', () => {
  const now = Date.parse('2026-10-14T10:00:00.000Z');
  test('counts up to the second and never goes negative', () => {
    expect(secondsLeft('2026-10-14T10:05:00.000Z', now)).toBe(300);
    expect(secondsLeft('2026-10-14T10:00:00.400Z', now)).toBe(1);
    expect(secondsLeft('2026-10-14T09:59:00.000Z', now)).toBe(0);
  });
});

describe('formatCountdown', () => {
  test('minutes and seconds, then hours, then Expired', () => {
    expect(formatCountdown(272)).toBe('4:32');
    expect(formatCountdown(9)).toBe('0:09');
    expect(formatCountdown(3600)).toBe('1 h 00 min');
    expect(formatCountdown(24 * 3600 - 60)).toBe('23 h 59 min');
    expect(formatCountdown(0)).toBe('Expired');
  });
});

describe('toolUseArgs', () => {
  test('reads the tool and the redacted input', () => {
    expect(
      toolUseArgs(row({ args: { toolName: 'Bash', input: 'ls -la' } })),
    ).toEqual({ toolName: 'Bash', input: 'ls -la' });
    expect(toolUseArgs(row({ args: { toolName: 'Read' } }))).toEqual({
      toolName: 'Read',
    });
  });
  test('is null for other kinds and for malformed args', () => {
    expect(
      toolUseArgs(row({ kind: 'pr_approve', args: { pr: 1 } })),
    ).toBeNull();
    expect(toolUseArgs(row({ args: { extra: 1 } }))).toBeNull();
  });
});

describe('requestTitle', () => {
  test('names what each kind asks for', () => {
    expect(requestTitle(row({}))).toBe('Use Bash');
    expect(requestTitle(row({ kind: 'pr_approve', args: { pr: 12 } }))).toBe(
      'Approve pull request #12',
    );
    expect(
      requestTitle(row({ kind: 'orchestrator_start', args: { mode: 'next' } })),
    ).toBe('Dispatch the next issue');
    expect(requestTitle(row({ kind: 'orchestrator_stop', args: {} }))).toBe(
      'Stop the orchestrator',
    );
    expect(requestTitle(row({ args: {} }))).toBe('Use a tool');
  });
});

describe('pending and recent', () => {
  const rows = [
    row({ id: 'late', expiresAt: '2026-10-14T11:00:00.000Z' }),
    row({ id: 'soon', expiresAt: '2026-10-14T10:01:00.000Z' }),
    row({ id: 'old', status: 'denied', createdAt: '2026-10-13T10:00:00.000Z' }),
    row({ id: 'new', status: 'executed' }),
  ];
  test('pending: soonest to expire first', () => {
    expect(pendingRequests(rows).map((r) => r.id)).toEqual(['soon', 'late']);
  });
  test('recent: decided only, newest first, capped', () => {
    expect(recentRequests(rows).map((r) => r.id)).toEqual(['new', 'old']);
    expect(recentRequests(rows, 1)).toHaveLength(1);
  });
});

describe('resultMessage', () => {
  test('takes message, then error, else null', () => {
    expect(resultMessage({ message: 'budget hard stop' })).toBe(
      'budget hard stop',
    );
    expect(resultMessage({ error: 'boom' })).toBe('boom');
    expect(resultMessage(null)).toBeNull();
    expect(resultMessage({ n: 1 })).toBeNull();
  });
});

describe('describeActionRequestError', () => {
  const failure = (status: number, error?: string) =>
    new ApiError(
      status,
      undefined as never,
      'm',
      undefined,
      error ? { error } : null,
    );
  test('maps the API codes to a sentence with the fix', () => {
    expect(describeActionRequestError(failure(409, 'not_pending'))).toMatch(
      /already decided/,
    );
    expect(describeActionRequestError(failure(403, 'self_approval'))).toMatch(
      /own request/,
    );
    expect(describeActionRequestError(failure(403))).toMatch(/operators/);
  });
});
