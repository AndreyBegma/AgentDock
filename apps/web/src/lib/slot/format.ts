import {
  type CommandRunView,
  type ConversationEntry,
  FLEET_ERROR,
  type FleetNodePill,
} from '@agentdock/shared';
import type {
  CheckpointKind,
  WorktreeFileStatus,
} from '@agentdock/shared/protocol';
import type { Status } from '@andrewbehma/glass-ui/status-pill';
import { ApiError, describeError } from '../api';
import { describeOutcome } from '../control/format';
import { CHECKPOINT_LABEL } from '../fleet/format';
import { formatDate } from '../format';
import {
  type RunnerFacts,
  type RunnerGate,
  runnerGate,
} from '../planner/runner-support';
import type { OutboxEntry } from './outbox';

/** The agent panel's tabs (#160), in order. */
export const SLOT_PANEL_TABS = [
  { id: 'chat', label: 'Chat' },
  { id: 'context', label: 'Context' },
  { id: 'worktree', label: 'Worktree' },
  { id: 'files', label: 'Files' },
  { id: 'tests', label: 'Tests' },
  { id: 'settings', label: 'Settings' },
  { id: 'pane', label: 'Pane' },
] as const;
export type SlotPanelTab = (typeof SLOT_PANEL_TABS)[number]['id'];

/** The panel's tab from the URL's `?tab=`; anything else is Chat (#213). */
export const parseSlotTab = (value: string | null): SlotPanelTab =>
  SLOT_PANEL_TABS.find((tab) => tab.id === value)?.id ?? 'chat';

/** The tabs that read `/worktree`: the runner is asked only while one is open. */
export const usesWorktree = (tab: SlotPanelTab): boolean =>
  tab === 'worktree' || tab === 'files';

/** A graph node's pill is already on glass-ui's status scale. */
export const NODE_PILL_STATUS: Record<FleetNodePill, Status> = {
  running: 'running',
  waiting: 'waiting',
  paused: 'paused',
  blocked: 'blocked',
  done: 'done',
};

export const NODE_PILL_LABEL: Record<FleetNodePill, string> = {
  running: 'running',
  waiting: 'waiting',
  paused: 'paused',
  blocked: 'blocked',
  done: 'done',
};

export const FILE_STATUS_LABEL: Record<WorktreeFileStatus, string> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
  type_changed: 'type changed',
  untracked: 'untracked',
};

/** The one-letter mark git uses, beside the path. */
export const FILE_STATUS_MARK: Record<WorktreeFileStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  type_changed: 'T',
  untracked: '?',
};

/** `+12 −3`; a binary or untracked file has no line counts and reads `—`. */
export function formatLineCounts(
  additions: number | null,
  deletions: number | null,
): string {
  if (additions === null && deletions === null) return '—';
  return `+${additions ?? 0} −${deletions ?? 0}`;
}

export { RUNNER_UPDATE_HREF } from '../planner/runner-support';

/**
 * #233: what stops the Worktree and Files tabs before they ask the runner.
 * With a gate the panel does not fetch `/worktree`; with none — an unknown
 * advert among them — it asks, and `isRunnerOutdated` reads the refusal.
 */
export const worktreeRunnerGate = (
  project: RunnerFacts | undefined,
): RunnerGate | null => runnerGate(project, 'worktree');

/**
 * `/worktree` says the runner predates `worktree.status`: the API's 409
 * `runner_outdated` from the runner's advert (#233), or — from a runner that
 * advertises nothing — the runner's own `unknown_command`, which the API
 * passes as the message's prefix
 * (`unknown_command: unknown command: worktree.status`).
 */
export const isRunnerOutdated = (error: unknown): boolean => {
  if (!(error instanceof ApiError)) return false;
  const code = error.code as string | undefined;
  return (
    code === FLEET_ERROR.runnerOutdated ||
    (code === FLEET_ERROR.worktreeUnavailable &&
      error.message.startsWith('unknown_command'))
  );
};

/** Why `/worktree` gave no answer, as the panel says it. */
export function describeWorktreeError(error: unknown): string {
  if (isRunnerOutdated(error)) {
    return 'The project’s runner is too old to read worktrees. Update the runner, then refresh.';
  }
  if (error instanceof ApiError) {
    switch (error.code as string | undefined) {
      case FLEET_ERROR.runnerOffline:
        return 'The project’s runner is offline, so the worktree cannot be read. It shows here again once the runner reconnects.';
      case FLEET_ERROR.runnerTimeout:
        return 'The runner did not answer in time. Refresh to ask again.';
      case FLEET_ERROR.worktreeUnavailable:
        // The runner's own wording is not a sentence for a person (#213).
        return 'The runner could not read this worktree. Refresh to try again.';
      case FLEET_ERROR.slotNotFound:
        return 'This slot has no run yet, so it has no worktree.';
    }
  }
  return describeError(error);
}

/** "Orchestrator" unless AgentDock's header names who sent it. */
export const ORCHESTRATOR_AUTHOR = 'Orchestrator';

/** What `ChatThread` draws for one conversation entry. */
export interface SlotChatMessage {
  id: string;
  author: string;
  time: string;
  dateTime: string;
  body: string;
  /** Which side wrote it, for the avatar and the badge. */
  side: 'orchestrator' | 'worker' | 'outbox';
  /** A worker section's checkpoint, as the badge says it. */
  checkpoint?: string;
  /** The same checkpoint, for the badge's tone. */
  checkpointKind?: CheckpointKind;
  /** An optimistic entry's state. */
  outbox?: OutboxEntry;
}

export function chatMessageOf(
  entry: ConversationEntry,
  slot: string,
): SlotChatMessage {
  const common = {
    id: entry.id,
    time: formatDate(entry.at, 'datetime'),
    dateTime: entry.at,
    body: entry.body,
  };
  if (entry.from === 'orchestrator') {
    return {
      ...common,
      author: entry.sender ?? ORCHESTRATOR_AUTHOR,
      side: 'orchestrator',
    };
  }
  return {
    ...common,
    author: slot,
    side: 'worker',
    checkpointKind: entry.checkpoint,
    checkpoint:
      entry.checkpoint === 'other'
        ? entry.heading
        : CHECKPOINT_LABEL[entry.checkpoint],
  };
}

/** The author of what this tab sent: AgentDock's header names the user. */
export const OUTBOX_AUTHOR = 'You';

export function outboxMessageOf(entry: OutboxEntry): SlotChatMessage {
  return {
    id: `outbox:${entry.id}`,
    author: OUTBOX_AUTHOR,
    time: formatDate(entry.at, 'datetime'),
    dateTime: entry.at,
    body: entry.text,
    side: 'outbox',
    outbox: entry,
  };
}

/** The thread: the conversation, then what this tab has not seen come back. */
export function chatMessages(
  entries: readonly ConversationEntry[],
  outbox: readonly OutboxEntry[],
  slot: string,
): SlotChatMessage[] {
  return [
    ...entries.map((entry) => chatMessageOf(entry, slot)),
    ...outbox.map(outboxMessageOf),
  ];
}

export const OUTBOX_STATE_LABEL: Record<OutboxEntry['state'], string> = {
  sending: 'Sending…',
  sent: 'Delivered to the worktree; waiting for the runner to see it.',
  failed: 'Not sent.',
};

/**
 * The worker's last word on local checks: the latest `implementation done`
 * section, which by the worker skill carries the check output.
 */
export function lastLocalChecks(
  entries: readonly ConversationEntry[],
): Extract<ConversationEntry, { from: 'worker' }> | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.from === 'worker' && entry.checkpoint === 'implementation_done') {
      return entry;
    }
  }
  return undefined;
}

/**
 * How a "message worker" run ended, for the outbox: `ok` is delivered to the
 * worktree; anything else, or no run at all (the POST failed; its toast says
 * why), is a failure with the sentence to show beside the message.
 */
export function messageOutcome(
  run:
    | Pick<CommandRunView, 'command' | 'slot' | 'status' | 'error'>
    | undefined,
): { ok: true } | { ok: false; error: string } {
  if (run === undefined) {
    return { ok: false, error: 'The request did not go through.' };
  }
  if (run.status === 'ok') return { ok: true };
  if (run.status === 'requested') {
    return { ok: false, error: 'The runner has not answered yet.' };
  }
  return {
    ok: false,
    error: describeOutcome(run)?.text ?? 'The message was not delivered.',
  };
}

/**
 * The brief's round, as an id: `2026-10-14/1830` names the board the slot was
 * dispatched from. It is not when the brief was written, so it is not drawn
 * as a timestamp (#213).
 */
export const briefRoundLabel = (round: string | null): string =>
  round === null ? '—' : `Round ${round}`;

/** The short form of a commit sha. */
export const shortSha = (sha: string): string => sha.slice(0, 7);
