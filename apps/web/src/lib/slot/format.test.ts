import { describe, expect, test } from 'bun:test';
import { type ConversationEntry, FLEET_ERROR } from '@agentdock/shared';
import { ApiError } from '../api';
import {
  chatMessageOf,
  chatMessages,
  describeWorktreeError,
  formatLineCounts,
  lastLocalChecks,
  messageOutcome,
  ORCHESTRATOR_AUTHOR,
  OUTBOX_AUTHOR,
  SLOT_PANEL_TABS,
  shortSha,
  usesWorktree,
} from './format';

const AT = '2026-10-14T10:00:00.000Z';

const fromOrchestrator = (sender: string | null = null): ConversationEntry => ({
  from: 'orchestrator',
  id: 'orchestrator:1',
  at: AT,
  sender,
  sentAt: null,
  body: 'plan approved',
  mode: 'replaced',
});

const fromWorker = (
  checkpoint: Extract<ConversationEntry, { from: 'worker' }>['checkpoint'],
  heading = 'blocked',
  id = 'worker:1',
): ConversationEntry => ({
  from: 'worker',
  id,
  at: AT,
  checkpoint,
  heading,
  body: 'body',
  position: 0,
});

// A fleet code is not an `AuthErrorCode`; the API sends it in the same field.
const apiError = (status: number, code: string, message = 'm') =>
  new ApiError(status, code as never, message);

describe('tabs', () => {
  test('the six tabs of #160, then the pane', () => {
    expect(SLOT_PANEL_TABS.map((t) => t.label)).toEqual([
      'Chat',
      'Context',
      'Worktree',
      'Files',
      'Tests',
      'Settings',
      'Pane',
    ]);
  });

  test('only Worktree and Files ask the runner', () => {
    expect(
      SLOT_PANEL_TABS.filter((t) => usesWorktree(t.id)).map((t) => t.id),
    ).toEqual(['worktree', 'files']);
  });
});

describe('describeWorktreeError', () => {
  test('each fleet code has its own sentence', () => {
    expect(
      describeWorktreeError(apiError(409, FLEET_ERROR.runnerOffline)),
    ).toContain('runner is offline');
    expect(
      describeWorktreeError(apiError(504, FLEET_ERROR.runnerTimeout)),
    ).toContain('did not answer in time');
    expect(
      describeWorktreeError(
        apiError(409, FLEET_ERROR.worktreeUnavailable, 'path_not_allowed'),
      ),
    ).toContain('(path_not_allowed)');
    expect(
      describeWorktreeError(apiError(404, FLEET_ERROR.slotNotFound)),
    ).toContain('no run yet');
  });

  test('a network failure is the app-wide sentence', () => {
    expect(describeWorktreeError(new TypeError('fetch'))).toBe(
      'Could not reach the server.',
    );
  });
});

describe('formatLineCounts', () => {
  test('counts, and a dash for a file without them', () => {
    expect(formatLineCounts(12, 3)).toBe('+12 −3');
    expect(formatLineCounts(4, null)).toBe('+4 −0');
    expect(formatLineCounts(null, null)).toBe('—');
  });
});

describe('chat messages', () => {
  test('an orchestrator message is signed by its sender, else "Orchestrator"', () => {
    expect(chatMessageOf(fromOrchestrator('a@b.c'), 'i1').author).toBe('a@b.c');
    const m = chatMessageOf(fromOrchestrator(), 'i1');
    expect(m).toMatchObject({
      author: ORCHESTRATOR_AUTHOR,
      side: 'orchestrator',
      dateTime: AT,
      body: 'plan approved',
    });
    expect(m.checkpoint).toBeUndefined();
  });

  test('a worker section is signed by the slot, with its checkpoint', () => {
    expect(chatMessageOf(fromWorker('pr_open'), 'i1')).toMatchObject({
      author: 'i1',
      side: 'worker',
      checkpoint: 'pull request open',
    });
    expect(chatMessageOf(fromWorker('other', 'notes'), 'i1').checkpoint).toBe(
      'notes',
    );
  });

  test('the outbox follows the conversation', () => {
    const list = chatMessages(
      [fromOrchestrator()],
      [{ id: 'x', text: 'hi', at: AT, state: 'sending' }],
      'i1',
    );
    expect(list.map((m) => [m.id, m.author, m.side])).toEqual([
      ['orchestrator:1', ORCHESTRATOR_AUTHOR, 'orchestrator'],
      ['outbox:x', OUTBOX_AUTHOR, 'outbox'],
    ]);
  });
});

describe('lastLocalChecks', () => {
  test('the latest implementation-done section, if any', () => {
    expect(lastLocalChecks([fromOrchestrator()])).toBeUndefined();
    const first = fromWorker('implementation_done', 'done', 'worker:1');
    const second = fromWorker('implementation_done', 'done again', 'worker:2');
    expect(
      lastLocalChecks([first, second, fromWorker('pr_open', 'pr', 'worker:3')])
        ?.id,
    ).toBe('worker:2');
  });
});

describe('messageOutcome', () => {
  const run = (status: 'ok' | 'error' | 'unknown' | 'requested') => ({
    command: 'slot.message' as const,
    slot: 'i1',
    status,
    error: null,
  });

  test('only ok is delivered', () => {
    expect(messageOutcome(run('ok'))).toEqual({ ok: true });
  });

  test('no run, a pending one, an error and no answer are failures that say why', () => {
    expect(messageOutcome(undefined)).toEqual({
      ok: false,
      error: 'The request did not go through.',
    });
    expect(messageOutcome(run('requested'))).toEqual({
      ok: false,
      error: 'The runner has not answered yet.',
    });
    const failed = messageOutcome(run('error'));
    expect(failed.ok).toBe(false);
    const unknown = messageOutcome(run('unknown'));
    expect(unknown).toMatchObject({ ok: false });
    expect(unknown.ok ? '' : unknown.error).toContain('never answered');
  });
});

test('shortSha', () => {
  expect(shortSha('0b6445a1234567890')).toBe('0b6445a');
});
