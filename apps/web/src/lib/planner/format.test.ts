import { describe, expect, test } from 'bun:test';
import {
  PLAN_STATUSES,
  PLAN_TASK_LIVE_STATUSES,
  PLAN_TASK_STATUSES,
  PLAN_TURN_ACTIONS,
  PLAN_TURN_PHASES,
  type PlanTaskIssueView,
} from '@agentdock/shared';
import { STATUSES } from '@andrewbehma/glass-ui/status-pill';
import { ApiError } from '../api';
import { plan, task, turn } from './fixtures';
import {
  approveHint,
  canApprove,
  canRevise,
  describePlannerError,
  failedTurn,
  isContractViolation,
  isRunnerTooOldError,
  LIVE_STATUS_PILL,
  PLAN_STATUS_PILL,
  planAttentionReason,
  planPill,
  RUNNER_TOO_OLD_TEXT,
  sendBlock,
  TASK_STATUS_PILL,
  TURN_PHASE_PILL,
  taskCountsText,
  taskStatusView,
  turnActionText,
  turnBody,
  turnsOf,
} from './format';

const issue = (over: Partial<PlanTaskIssueView> = {}): PlanTaskIssueView => ({
  number: 41,
  url: 'https://github.com/o/r/issues/41',
  liveStatus: 'in_flight',
  prNumber: null,
  prUrl: null,
  ...over,
});

describe('status maps', () => {
  test('every planner status maps onto glass-ui’s scale', () => {
    for (const s of PLAN_STATUSES) {
      expect(STATUSES).toContain(PLAN_STATUS_PILL[s]);
    }
    for (const s of PLAN_TASK_STATUSES) {
      expect(STATUSES).toContain(TASK_STATUS_PILL[s]);
    }
    for (const s of PLAN_TASK_LIVE_STATUSES) {
      expect(STATUSES).toContain(LIVE_STATUS_PILL[s]);
    }
    for (const s of PLAN_TURN_PHASES) {
      expect(STATUSES).toContain(TURN_PHASE_PILL[s]);
    }
  });

  test('an issued task shows its live status; before that, its own', () => {
    expect(taskStatusView(task({ status: 'needs_talk' }))).toEqual({
      status: 'blocked',
      label: 'Needs talk',
    });
    expect(taskStatusView(task({ status: 'issued', issue: issue() }))).toEqual({
      status: 'running',
      label: 'In flight',
    });
    expect(
      taskStatusView(
        task({ status: 'issued', issue: issue({ liveStatus: 'merged' }) }),
      ).label,
    ).toBe('Merged');
  });

  test('an issue not queued yet (live status null) reads as Issued', () => {
    const waiting = {
      ...issue(),
      liveStatus: null,
    } as unknown as PlanTaskIssueView;
    expect(taskStatusView(task({ status: 'issued', issue: waiting }))).toEqual({
      status: 'done',
      label: 'Issued',
    });
  });

  test('task counts read most actionable first, zeros left out', () => {
    expect(taskCountsText({ approved: 2, needs_talk: 1, draft: 0 })).toBe(
      '1 needs talk · 2 approved',
    );
    expect(taskCountsText({})).toBeNull();
  });
});

describe('turns', () => {
  test('every action has a running sentence naming the task', () => {
    for (const action of PLAN_TURN_ACTIONS) {
      expect(turnActionText({ action, taskKey: 't3' })).toMatch(/…$/);
    }
    expect(turnActionText({ action: 'grill', taskKey: 't3' })).toBe(
      'Thinking about t3…',
    );
    expect(turnActionText({ action: 'decompose', taskKey: null })).toBe(
      'Splitting the brief into tasks…',
    );
  });

  test('the failed turn of a scope is its newest, and only while nothing replaced it', () => {
    const failed = turn({
      id: 'b',
      phase: 'failed',
      createdAt: '2026-10-13T11:00:00.000Z',
    });
    expect(failedTurn([turn({ id: 'a' }), failed], null)?.id).toBe('b');
    const retried = turn({ id: 'c', createdAt: '2026-10-13T12:00:00.000Z' });
    expect(failedTurn([failed, retried], null)).toBeNull();
    // A task's failed turn is not the plan's.
    expect(failedTurn([{ ...failed, taskKey: 't1' }], null)).toBeNull();
    expect(failedTurn([{ ...failed, taskKey: 't1' }], 't1')?.id).toBe('b');
  });

  test('a contract violation is told apart from a runner error', () => {
    expect(
      isContractViolation({ error: 'contract_violation: unknown_key: x' }),
    ).toBe(true);
    expect(isContractViolation({ error: 'runner_timeout' })).toBe(false);
    expect(isContractViolation({ error: null })).toBe(false);
  });

  test('an earlier turn reads as its message, its answers and its outcome', () => {
    expect(
      turnBody(
        turn({
          action: 'grill',
          phase: 'succeeded',
          input: {
            message: 'Keep it small.',
            answers: [
              { questionId: 'q1', optionId: 'db' },
              { questionId: 'q2', optionId: 'a', text: 'but cap it' },
              { questionId: 'q3', text: 'Planner' },
            ],
          },
        }),
      ),
    ).toBe(
      'Keep it small.\nq1: db\nq2: a — but cap it\nq3: Planner\nTalk it through · done',
    );
  });

  test('turns of a task, oldest first', () => {
    const t = turnsOf(
      [
        turn({ id: '2', taskKey: 't1', createdAt: '2026-10-13T12:00:00.000Z' }),
        turn({ id: 'p', taskKey: null }),
        turn({ id: '1', taskKey: 't1', createdAt: '2026-10-13T11:00:00.000Z' }),
      ],
      't1',
    );
    expect(t.map((x) => x.id)).toEqual(['1', '2']);
  });
});

describe('what the person may do', () => {
  test('approve is refused while a blocking question is open (D6)', () => {
    expect(canApprove(task({ status: 'ready' }))).toBe(true);
    expect(canApprove(task({ status: 'needs_talk', blockingOpen: 1 }))).toBe(
      false,
    );
    expect(canApprove(task({ status: 'approved' }))).toBe(false);
    expect(canApprove(task({ status: 'issued' }))).toBe(false);
  });

  test('approve waits on the design while the task needs one (spec 223 D1)', () => {
    const needsDesign = task({ status: 'needs_design' });
    expect(canApprove(needsDesign)).toBe(false);
    expect(approveHint(needsDesign)).toBe('Approve the design first.');
    expect(approveHint(task({ status: 'needs_talk', blockingOpen: 2 }))).toBe(
      'Answer the blocking questions first.',
    );
    expect(approveHint(task())).toBeUndefined();
    expect(taskCountsText({ needs_design: 2, approved: 1 })).toBe(
      '2 needs design · 1 approved',
    );
  });

  test('Send to fleet needs an approved task and none in needs_talk (D8)', () => {
    expect(sendBlock(plan())).toBe('needs_talk');
    const ok = plan({
      tasks: [
        task({ status: 'approved' }),
        task({ key: 't2', status: 'rejected' }),
      ],
    });
    expect(sendBlock(ok)).toBeNull();
    expect(sendBlock(plan({ tasks: [task({ status: 'ready' })] }))).toBe(
      'no_approved',
    );
    expect(sendBlock({ ...ok, activeTurnId: 'turn-9' })).toBe(
      'turn_in_progress',
    );
    expect(sendBlock({ ...ok, status: 'sent' })).toBe('closed');
  });

  test('Revise plan is enabled when a rewrite is pending (D9)', () => {
    expect(canRevise(plan())).toBe(false);
    expect(
      canRevise(plan({ tasks: [task({ status: 'rewrite_requested' })] })),
    ).toBe(true);
    expect(
      canRevise(
        plan({
          status: 'sent',
          tasks: [task({ status: 'rewrite_requested' })],
        }),
      ),
    ).toBe(false);
  });
});

describe('planPill (#213)', () => {
  const failed = turn({
    id: 'turn-2',
    phase: 'failed',
    error: 'boom',
    createdAt: '2026-10-13T11:00:00.000Z',
  });

  test('a drafting plan whose newest turn failed is Failed, not Drafting', () => {
    expect(planPill(plan({ status: 'drafting', turns: [failed] }))).toEqual({
      status: 'error',
      label: 'Failed',
    });
  });

  test('a failed task turn on a plan under review needs attention', () => {
    expect(
      planPill(plan({ status: 'reviewing', turns: [turn(), failed] })).label,
    ).toBe('Needs attention');
  });

  test('a retry newer than the failure clears it', () => {
    const retry = turn({
      id: 'turn-3',
      phase: 'running',
      createdAt: '2026-10-13T12:00:00.000Z',
    });
    expect(
      planPill(plan({ status: 'drafting', turns: [failed, retry] })).label,
    ).toBe('Drafting');
  });

  test('a sent plan stays Sent', () => {
    expect(planPill(plan({ status: 'sent', turns: [failed] })).label).toBe(
      'Sent',
    );
  });

  test('a list row reads the API’s attention, and its absence as none', () => {
    const row = { status: 'drafting' as const };
    expect(planPill(row).label).toBe('Drafting');
    expect(
      planPill({
        ...row,
        attention: { kind: 'failed', reason: 'x', turnId: 't', at: 'a' },
      }).label,
    ).toBe('Failed');
  });

  test('the row reason names an old runner in words', () => {
    expect(
      planAttentionReason({
        attention: {
          kind: 'failed',
          reason: 'plan.turn failed on the runner: unknown_command',
          turnId: 't',
          at: 'a',
        },
      }),
    ).toBe(RUNNER_TOO_OLD_TEXT);
    expect(planAttentionReason({ attention: null })).toBeNull();
    expect(planAttentionReason({})).toBeNull();
  });
});

describe('describePlannerError', () => {
  const err = (status: number, error: string, message = 'm') =>
    new ApiError(status, undefined, message, undefined, {
      statusCode: status,
      error,
      message,
    });

  test('names the planner refusals in sentences', () => {
    expect(describePlannerError(err(409, 'needs_talk'))).toMatch(/blocking/);
    expect(describePlannerError(err(409, 'turn_in_progress'))).toMatch(
      /still running/,
    );
    expect(
      describePlannerError(err(409, 'dependency_cycle', 't1 → t2 → t1')),
    ).toBe('The tasks depend on each other in a cycle: t1 → t2 → t1');
  });

  test('a private plan is a 404, said without confirming it exists', () => {
    expect(
      describePlannerError(new ApiError(404, undefined, 'Not Found')),
    ).toMatch(/private to its author/);
  });

  test('a runner that does not know plan.turn is said to be too old', () => {
    expect(
      describePlannerError(
        err(
          502,
          'command_failed',
          'plan.turn failed on the runner: unknown_command — unknown command: plan.turn',
        ),
      ),
    ).toBe(RUNNER_TOO_OLD_TEXT);
  });

  test('the API’s runner_outdated is too old, whatever its message (#233)', () => {
    const outdated = err(
      409,
      'runner_outdated',
      'The runner does not serve plan.turn',
    );
    expect(describePlannerError(outdated)).toBe(RUNNER_TOO_OLD_TEXT);
    expect(isRunnerTooOldError(outdated)).toBe(true);
    expect(
      isRunnerTooOldError(err(502, 'command_failed', 'unknown_command')),
    ).toBe(true);
    expect(isRunnerTooOldError(err(409, 'turn_in_progress'))).toBe(false);
  });

  test('an offline runner is not called too old', () => {
    expect(
      describePlannerError(
        err(503, 'command_unavailable', 'The runner is not connected'),
      ),
    ).toMatch(/offline/);
  });

  test('a network failure is a sentence too', () => {
    expect(describePlannerError(new TypeError('fetch failed'))).toMatch(
      /connection/,
    );
  });
});
