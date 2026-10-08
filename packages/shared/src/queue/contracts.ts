import type { QueuePriority, SpecGap, WaveSlot } from './rules';

/** D3's states, in precedence order. */
export const QUEUE_STATES = [
  'in_flight',
  'blocked_person',
  'blocked_work',
  'no_spec',
  'ready',
] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

/** How the orchestrator writes each state on its board. */
export const QUEUE_STATE_LABELS: Record<QueueState, string> = {
  in_flight: 'IN FLIGHT',
  ready: 'READY',
  blocked_work: 'BLOCKED — work',
  blocked_person: 'BLOCKED — person',
  no_spec: 'NO SPEC',
};

/** `computed`: AgentDock's D3 rules; `orchestrator`: a fresher round's verdict (D4). */
export const QUEUE_SOURCES = ['computed', 'orchestrator'] as const;
export type QueueSource = (typeof QUEUE_SOURCES)[number];

export interface QueueVerdict {
  state: QueueState;
  why: string;
  /** What would clear it; null for `ready` and `in_flight`. */
  clears: string | null;
}

/** An issue named as a blocker (`Depends on #m`). */
export interface QueueBlocker {
  number: number;
  url: string;
  /** Open on GitHub; false when closed but not by a merged pull request. */
  open: boolean;
}

export interface QueueItemView extends QueueVerdict {
  number: number;
  title: string;
  url: string;
  labels: string[];
  assignees: string[];
  source: QueueSource;
  /**
   * AgentDock's own verdict when `source` is `orchestrator` (D4: the UI notes
   * "AgentDock computes X" when it differs); null otherwise.
   */
  computed: QueueVerdict | null;
  priority: QueuePriority | null;
  blockers: QueueBlocker[];
  /** The slots of the body's `## Parallel plan`; null without one (D5). */
  waveSlots: WaveSlot[] | null;
  ghUpdatedAt: string;
}

/** A row of the latest round's `Held for a lead` table (D5). */
export interface HeldForLeadRow {
  slot: string;
  waitingOn: string;
  dispatchWhen: string;
}

/** An open issue without the ready label: listed, never given a state. */
export interface OpenIssueView {
  number: number;
  title: string;
  url: string;
  labels: string[];
}

export interface QueueRoundRef {
  date: string;
  round: string;
  updatedAt: string;
}

/** Why the collector cannot read the project's issues (`issues.unavailable`). */
export interface QueueUnavailable {
  reason: string;
  at: string;
}

/** `GET /projects/:id/queue` — ready issues in D6 order. */
export interface QueueView {
  /** When the runner last fetched the issues; null before the first snapshot. */
  snapshotAt: string | null;
  /** Set while the last poll failed; cleared by the next snapshot. */
  unavailable: QueueUnavailable | null;
  readyLabel: string;
  /** The round the `orchestrator` verdicts and `heldForLead` come from. */
  round: QueueRoundRef | null;
  items: QueueItemView[];
  heldForLead: HeldForLeadRow[];
  /** Only with `?include=open`: open issues without the ready label. */
  others?: OpenIssueView[];
}

/** One issue's verdict in one round (newest first). */
export interface QueueHistoryEntry extends QueueVerdict {
  date: string;
  round: string;
}

/** `GET /projects/:id/queue/:number`. */
export interface QueueIssueDetail extends QueueItemView {
  /** Markdown, trimmed by the runner to 64 KB. */
  body: string;
  history: QueueHistoryEntry[];
}

/** `POST /projects/:id/issues`. */
export interface CreateIssueRequest {
  title: string;
  body: string;
  labels: string[];
  queue: boolean;
}

export interface CreateIssueResult {
  number: number;
  url: string;
  /** Whether the ready label was added (D7). */
  queued: boolean;
  reason?: SpecGap;
}

/** `POST /projects/:id/queue/refresh`: the runner polled now. */
export interface QueueRefreshResult {
  /** False when GitHub answered `304`: nothing changed, nothing was emitted. */
  changed: boolean;
  fetchedAt: string;
}

/** The body of a queue route's error. */
export interface QueueErrorBody {
  statusCode: number;
  error: QueueErrorCode;
  message: string;
  /** With `label_not_allowed`: the labels refused. */
  labels?: string[];
}

/** Rounds a detail's `history` looks back over. */
export const QUEUE_HISTORY_ROUNDS = 20;

/** Live event name on topic `project:<id>` (D9). Clients refetch on it. */
export const QUEUE_LIVE_EVENT = 'queue';

export interface QueueLiveChange {
  kind: 'queue';
  projectId: string;
}

/** Stable codes in the `error` field of a queue route's error body. */
export const QUEUE_ERROR = {
  issueNotFound: 'issue_not_found',
  noAcceptanceCriteria: 'no_acceptance_criteria',
  noParallelPlan: 'no_parallel_plan',
  labelNotAllowed: 'label_not_allowed',
  /** The runner command is not wired yet, or the runner is unreachable. */
  commandUnavailable: 'command_unavailable',
  commandFailed: 'command_failed',
} as const;
export type QueueErrorCode = (typeof QUEUE_ERROR)[keyof typeof QUEUE_ERROR];
