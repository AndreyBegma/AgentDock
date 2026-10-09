import type { ActivityItem } from '../activity/contracts';
import type {
  CheckpointKind,
  PrChecks,
  SlotRuntime,
  TokenBuckets,
} from '../protocol';

/**
 * Execution history (docs/specs/21 D7): one run per unit of agent work. In
 * this item a run is an orchestrator slot; skill and schedule runs (M3) add
 * rows of their own kinds.
 */
export const RUN_KINDS = ['orchestrator_slot', 'skill', 'schedule'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/**
 * - `running` — work in progress;
 * - `blocked` — the worker reported `blocked` or `misclassified`;
 * - `waiting_person` — a launch prompt or the quota banner, or its PR waits
 *   for review with the worker done;
 * - `succeeded` — its PR merged;
 * - `failed` — its PR was closed unmerged and the worker is gone;
 * - `abandoned` — the worker is gone and there is no PR.
 */
export const RUN_STATUSES = [
  'running',
  'blocked',
  'waiting_person',
  'succeeded',
  'failed',
  'abandoned',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** What a run delivers: a report, or a pull request. */
export const RUN_OUTPUTS = ['report', 'pr'] as const;
export type RunOutput = (typeof RUN_OUTPUTS)[number];

export const RUN_TRIGGERS = [
  'orchestrator',
  'user',
  'schedule',
  'webhook',
] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const RUN_PAGE_DEFAULT = 50;
export const RUN_PAGE_MAX = 200;

/** Live event on `project:<id>` when a run is created or changes (D9). */
export const RUN_UPDATED_LIVE_EVENT = 'run.updated';

/** `run.updated` payload: re-read the run over REST. */
export interface RunLiveChange {
  id: string;
  status: RunStatus;
}

/**
 * Tokens and cost of a run (D8): its slot's `llm_requests` within the run's
 * window, computed on read. `costUsd` sums the priced requests — a decimal
 * string, null while none is priced; `unpricedRequests` counts the rest.
 */
export interface RunUsage extends TokenBuckets {
  requests: number;
  costUsd: string | null;
  unpricedRequests: number;
}

export interface RunSummary {
  id: string;
  kind: RunKind;
  projectId: string;
  slotId: string | null;
  /** The slot's name, for an `orchestrator_slot` run. */
  slot: string | null;
  issue: number | null;
  title: string | null;
  runtime: SlotRuntime | null;
  model: string | null;
  profileKey: string | null;
  output: RunOutput | null;
  status: RunStatus;
  /** The last checkpoint's summary. */
  outcome: string | null;
  prNumber: number | null;
  prUrl: string | null;
  /** The slot's current PR checks, when it has a PR. */
  prChecks: PrChecks | null;
  triggeredByType: RunTrigger;
  triggeredById: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  updatedAt: string;
  usage: RunUsage;
}

export interface RunPage {
  items: RunSummary[];
  /** Pass as `cursor` for the next (older) page; null on the last page. */
  nextCursor: string | null;
}

/** `GET /projects/:projectId/runs`. `from`/`to` bound `startedAt` (ISO, `to` exclusive). */
export interface RunListQuery {
  kind?: RunKind;
  status?: RunStatus;
  issue?: number;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

export interface RunCheckpoint {
  kind: CheckpointKind;
  heading: string;
  summary: string;
  position: number;
  at: string;
}

/** An agent session of the run's slot (#12), with its own tokens and cost. */
export interface RunSession {
  id: string;
  runtime: SlotRuntime;
  externalId: string;
  title: string | null;
  startedAt: string;
  lastEventAt: string;
  endedAt: string | null;
  usage: RunUsage;
}

/** `GET /projects/:projectId/runs/:runId`. */
export interface RunDetail extends RunSummary {
  checkpoints: RunCheckpoint[];
  sessions: RunSession[];
  /** The newest feed items of the slot within the run's window. */
  activity: ActivityItem[];
}

/** Items `RunDetail.activity` holds at most. */
export const RUN_DETAIL_ACTIVITY_MAX = 100;
