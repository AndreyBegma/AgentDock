import {
  PLANNER_ERROR,
  type PlanDetail,
  type PlannerErrorCode,
  type PlannerSpecOutput,
  type PlanStatus,
  type PlanSummary,
  type PlanTaskKind,
  type PlanTaskLiveStatus,
  type PlanTaskStatus,
  type PlanTaskView,
  type PlanTurnAction,
  type PlanTurnPhase,
  type PlanTurnView,
} from '@agentdock/shared';
import type { Hue } from '@andrewbehma/glass-ui/hue';
import type { Status } from '@andrewbehma/glass-ui/status-pill';
import { ApiError } from '../api';
import { pluralize } from '../format';

/**
 * The Planner's words and colours (spec 172 "UI"). Statuses map onto
 * glass-ui's status scale, as `lib/status/pill.ts` does for slots and runs;
 * the wording stays ours.
 */

export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  clarifying: 'Clarifying',
  drafting: 'Drafting',
  reviewing: 'Reviewing',
  sending: 'Sending',
  sent: 'Sent',
  archived: 'Archived',
};

export const PLAN_STATUS_PILL: Record<PlanStatus, Status> = {
  // Waits on the person's answers.
  clarifying: 'waiting',
  drafting: 'running',
  // Waits on the person's review.
  reviewing: 'waiting',
  sending: 'running',
  sent: 'done',
  archived: 'idle',
};

export const TASK_STATUS_LABEL: Record<PlanTaskStatus, string> = {
  draft: 'Draft',
  needs_talk: 'Needs talk',
  ready: 'Ready',
  approved: 'Approved',
  rejected: 'Rejected',
  rewrite_requested: 'Rewrite requested',
  issued: 'Issued',
};

export const TASK_STATUS_PILL: Record<PlanTaskStatus, Status> = {
  draft: 'idle',
  // A blocking question has no safe default (D6): it waits on a person.
  needs_talk: 'blocked',
  ready: 'waiting',
  approved: 'done',
  rejected: 'idle',
  rewrite_requested: 'paused',
  issued: 'done',
};

export const LIVE_STATUS_LABEL: Record<PlanTaskLiveStatus, string> = {
  queued: 'Queued',
  in_flight: 'In flight',
  pr_open: 'PR open',
  merged: 'Merged',
  closed: 'Closed',
};

export const LIVE_STATUS_PILL: Record<PlanTaskLiveStatus, Status> = {
  queued: 'waiting',
  in_flight: 'running',
  // The work is done; it waits on review and merge.
  pr_open: 'paused',
  merged: 'done',
  closed: 'idle',
};

export const TURN_PHASE_PILL: Record<PlanTurnPhase, Status> = {
  queued: 'waiting',
  running: 'running',
  succeeded: 'done',
  failed: 'error',
  cancelled: 'idle',
};

export const KIND_LABEL: Record<PlanTaskKind, string> = {
  bug: 'Bug',
  feature: 'Feature',
};

/**
 * A task's kind is an identity, not a state: a fixed hue per kind, so a bug
 * reads the same on its card and on its graph node. Not `hueFor` — there are
 * two kinds and they must never land on the same hue.
 */
export const KIND_HUE: Record<PlanTaskKind, Hue> = {
  bug: 5,
  feature: 7,
};

export const SPEC_OUTPUT_LABEL: Record<PlannerSpecOutput, string> = {
  docs_pr:
    'Specifications go to one docs pull request; features are queued when it merges, bugs at once.',
  issue_body:
    'Each issue body is the whole specification; every issue is queued at once.',
};

/** What a task shows: its live status once issued, its own status before. */
export function taskStatusView(task: Pick<PlanTaskView, 'status' | 'issue'>): {
  status: Status;
  label: string;
} {
  // Null: the issue exists but is not queued yet — a feature waiting for its
  // docs pull request (D10). It reads as the task's own `issued`.
  const live: PlanTaskLiveStatus | null = task.issue?.liveStatus ?? null;
  if (live !== null) {
    return { status: LIVE_STATUS_PILL[live], label: LIVE_STATUS_LABEL[live] };
  }
  if (task.issue) {
    return {
      status: TASK_STATUS_PILL.issued,
      label: TASK_STATUS_LABEL.issued,
    };
  }
  return {
    status: TASK_STATUS_PILL[task.status],
    label: TASK_STATUS_LABEL[task.status],
  };
}

/** Task counts of a plan list row, most actionable first: "2 needs talk · 3 approved". */
const COUNT_ORDER: readonly PlanTaskStatus[] = [
  'needs_talk',
  'rewrite_requested',
  'ready',
  'draft',
  'approved',
  'issued',
  'rejected',
];

export function taskCountsText(
  counts: PlanSummary['taskCounts'],
): string | null {
  const parts = COUNT_ORDER.flatMap((status) => {
    const n = counts[status] ?? 0;
    return n > 0 ? [`${n} ${TASK_STATUS_LABEL[status].toLowerCase()}`] : [];
  });
  return parts.length > 0 ? parts.join(' · ') : null;
}

export const blockingText = (n: number): string | null =>
  n > 0 ? `${n} blocking` : null;

// Turns

/** The sentence a running turn shows. */
export function turnActionText(
  turn: Pick<PlanTurnView, 'action' | 'taskKey'>,
): string {
  const task = turn.taskKey ?? 'the task';
  const sentence: Record<PlanTurnAction, string> = {
    decompose: 'Splitting the brief into tasks…',
    clarify: 'Thinking about the brief…',
    grill: `Thinking about ${task}…`,
    write: `Writing ${task}’s document…`,
    revise: 'Revising the plan…',
  };
  return sentence[turn.action];
}

export const isActiveTurn = (turn: Pick<PlanTurnView, 'phase'>): boolean =>
  turn.phase === 'queued' || turn.phase === 'running';

/** The plan's active turn, if any. */
export function activeTurn(plan: PlanDetail): PlanTurnView | null {
  if (!plan.activeTurnId) return null;
  return plan.turns.find((t) => t.id === plan.activeTurnId) ?? null;
}

/**
 * The newest turn of a scope (the plan, or one task) when it failed and
 * nothing newer replaced it: that is the one **Retry turn** applies to.
 */
export function failedTurn(
  turns: readonly PlanTurnView[],
  taskKey: string | null,
): PlanTurnView | null {
  const scoped = turns.filter((t) => t.taskKey === taskKey);
  const last = scoped.reduce<PlanTurnView | null>(
    (latest, t) =>
      latest === null || t.createdAt > latest.createdAt ? t : latest,
    null,
  );
  return last?.phase === 'failed' ? last : null;
}

/** D17: the output did not validate, and the raw text was kept. */
export const isContractViolation = (
  turn: Pick<PlanTurnView, 'error'>,
): boolean =>
  turn.error?.startsWith(`${PLANNER_ERROR.contractViolation}`) ?? false;

/** The turns of one task, oldest first, or the plan-level ones (`null`). */
export const turnsOf = (
  turns: readonly PlanTurnView[],
  taskKey: string | null,
): PlanTurnView[] =>
  turns
    .filter((t) => t.taskKey === taskKey)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

export const TURN_ACTION_LABEL: Record<PlanTurnAction, string> = {
  decompose: 'Split the brief',
  clarify: 'Clarify the brief',
  grill: 'Talk it through',
  write: 'Write the document',
  revise: 'Revise the plan',
};

const TURN_PHASE_WORD: Record<PlanTurnPhase, string> = {
  queued: 'queued',
  running: 'running',
  succeeded: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

/**
 * An earlier turn as a chat entry: what the person sent — the message, and
 * each answer as `id: option — words` (the questions themselves are not on
 * the turn) — then what became of it.
 */
export function turnBody(
  turn: Pick<PlanTurnView, 'action' | 'input' | 'phase'>,
): string {
  const lines: string[] = [];
  if (turn.input.message) lines.push(turn.input.message);
  for (const a of turn.input.answers ?? []) {
    const parts = [a.optionId, a.text].filter(Boolean).join(' — ');
    lines.push(`${a.questionId}: ${parts}`);
  }
  lines.push(
    `${TURN_ACTION_LABEL[turn.action]} · ${TURN_PHASE_WORD[turn.phase]}`,
  );
  return lines.join('\n');
}

// What the person may do

export const isClosed = (plan: Pick<PlanSummary, 'status'>): boolean =>
  plan.status === 'sent' ||
  plan.status === 'archived' ||
  plan.status === 'sending';

/** Statuses a task can be approved from; `needs_talk` waits on its answers (D6). */
const APPROVABLE: readonly PlanTaskStatus[] = [
  'draft',
  'ready',
  'rejected',
  'rewrite_requested',
];

/** D6: approve is refused while a blocking question is open. */
export const canApprove = (
  task: Pick<PlanTaskView, 'status' | 'blockingOpen'>,
): boolean => task.blockingOpen === 0 && APPROVABLE.includes(task.status);

/** D9: Revise plan runs when at least one rewrite is pending. */
export const canRevise = (plan: PlanDetail): boolean =>
  !isClosed(plan) && plan.tasks.some((t) => t.status === 'rewrite_requested');

export type SendBlock =
  | 'closed'
  | 'turn_in_progress'
  | 'no_approved'
  | 'needs_talk';

export const SEND_BLOCK_TEXT: Record<SendBlock, string> = {
  closed: 'This plan was sent or archived.',
  turn_in_progress: 'Wait for the running turn to finish.',
  no_approved: 'Approve at least one task first.',
  needs_talk: 'A task still has a blocking question.',
};

/** D8: at least one approved task, and none in `needs_talk`. Null = sendable. */
export function sendBlock(plan: PlanDetail): SendBlock | null {
  if (isClosed(plan)) return 'closed';
  if (plan.activeTurnId) return 'turn_in_progress';
  if (plan.tasks.some((t) => t.status === 'needs_talk')) return 'needs_talk';
  if (!plan.tasks.some((t) => t.status === 'approved')) return 'no_approved';
  return null;
}

/** The issues Send to fleet will create, in dependency order where it can. */
export const tasksToSend = (plan: PlanDetail): PlanTaskView[] =>
  plan.tasks.filter((t) => t.status === 'approved');

/** The issue label a task's kind gets on send (D8). */
export const ISSUE_LABEL: Record<PlanTaskKind, string> = {
  bug: 'bug',
  feature: 'enhancement',
};

// Errors

const ERROR_TEXT: Partial<Record<PlannerErrorCode, string>> = {
  not_found: 'This plan does not exist, or it is private to its author.',
  forbidden: 'Your role in this project cannot do that.',
  turn_in_progress:
    'A turn of this plan is still running. Wait for it, or cancel it.',
  needs_talk: 'This task has a blocking question. Answer it before approving.',
  not_sendable:
    'Nothing to send: approve a task, and settle every blocking question.',
  plan_closed: 'This plan was sent or archived; it takes no more changes.',
  contract_violation:
    'The planner’s answer did not follow the output contract. Nothing was changed.',
  unsupported_runtime:
    'The planner runs on Claude only; this profile is Codex.',
  no_profile: 'The project has no runtime profile to plan with.',
  unknown_profile: 'That runtime profile no longer exists on the runner.',
  budget_exceeded: 'A budget refuses new runs in this project.',
  command_unavailable: 'The runner is too old to run the planner. Update it.',
  runner_timeout: 'The runner did not answer in time.',
};

/** A sentence for a failed planner request. */
export function describePlannerError(error: unknown): string {
  if (error instanceof ApiError) {
    const code = error.body?.error;
    const known =
      typeof code === 'string'
        ? ERROR_TEXT[code as PlannerErrorCode]
        : undefined;
    if (code === PLANNER_ERROR.dependencyCycle) {
      return `The tasks depend on each other in a cycle: ${error.message}`;
    }
    if (known) return known;
    if (error.status === 404) return ERROR_TEXT.not_found ?? error.message;
    if (error.status === 403) return ERROR_TEXT.forbidden ?? error.message;
    return error.message;
  }
  return 'The request failed. Check your connection and try again.';
}

export const isNotFound = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;

export const tasksLabel = (n: number): string => pluralize(n, 'task');

/** Why the person cannot write to this plan now, or null when they can. */
export function writeBlock(
  plan: PlanDetail,
  canOperate: boolean,
): string | null {
  if (!canOperate) {
    return 'Viewers can read a plan; an operator talks to the planner.';
  }
  if (plan.status === 'sent') {
    return 'This plan was sent. Follow-up work is a new plan.';
  }
  if (plan.status === 'archived') return 'This plan is archived.';
  if (plan.status === 'sending') return 'This plan is being sent.';
  return null;
}
