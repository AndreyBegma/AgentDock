import type {
  CheckpointKind,
  PrChecks,
  RoundDecisions,
  SlotRuntime,
} from '../protocol';

/**
 * A slot's state (spec 11 D8), derived from what the collectors last saw:
 * - `dispatched` — its brief exists, its tmux session has not appeared yet;
 * - `running` / `idle` / `prompt` / `quota` — the session is alive, and its
 *   pane is busy, idle, waiting on a launch dialog or on the quota banner;
 * - `stale` — the session vanished, the worktree is still there and its PR is
 *   not merged (the orchestrator's dead slot);
 * - `ended` — the session vanished and the PR merged or the worktree is gone.
 */
export const SLOT_STATUSES = [
  'dispatched',
  'running',
  'idle',
  'prompt',
  'quota',
  'stale',
  'ended',
] as const;
export type SlotStatus = (typeof SLOT_STATUSES)[number];

/** What the slot's pane showed last, while its session was alive. */
export const PANE_STATES = ['busy', 'prompt', 'idle', 'quota'] as const;
export type PaneState = (typeof PANE_STATES)[number];

export const PR_STATES = ['open', 'merged', 'closed'] as const;
export type PrState = (typeof PR_STATES)[number];

/** `unknown`: nothing has been observed for this project yet (D6). */
export const ORCHESTRATOR_STATUSES = [
  'running',
  'idle',
  'absent',
  'unknown',
] as const;
export type OrchestratorStatus = (typeof ORCHESTRATOR_STATUSES)[number];

/** `scraped`: parsed from a board file; `events`: from `events.jsonl` (M2.1). */
export type RoundSource = 'scraped' | 'events';

export interface SlotSummary {
  id: string;
  name: string;
  issue: number | null;
  branch: string | null;
  runtime: SlotRuntime;
  model: string | null;
  modelWhy: string | null;
  lead: boolean | null;
  status: SlotStatus;
  /** `YYYY-MM-DD/HHMM` of the brief that dispatched it. */
  round: string | null;
  lastCheckpoint: CheckpointKind | null;
  prNumber: number | null;
  prUrl: string | null;
  prChecks: PrChecks | null;
  ahead: number | null;
  behind: number | null;
  dirty: boolean | null;
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
}

export interface SlotCheckpointView {
  id: string;
  kind: CheckpointKind;
  /** The heading as written, without `## `. */
  heading: string;
  summary: string;
  /** Index of the heading in the reply file; the list is ordered by it. */
  position: number;
  /** When the runner first saw it. */
  at: string;
}

/** `GET /projects/:id/slots/:slot` — the latest slot by that name. */
export interface SlotDetail extends SlotSummary {
  worktree: string;
  owns: string[];
  never: string[];
  sessionAlive: boolean;
  pane: PaneState | null;
  worktreeExists: boolean;
  prState: PrState | null;
  prMergeable: boolean | null;
  checkpoints: SlotCheckpointView[];
}

export interface RoundHeader {
  id: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** `HHMM`. */
  label: string;
  base: string;
  occupied: number;
  max: number;
  free: number;
  source: RoundSource;
  boardPath: string;
  createdAt: string;
}

/** `GET /projects/:id/rounds` — newest first. */
export interface RoundView extends RoundHeader {
  decisions: RoundDecisions;
}

export interface OrchestratorView {
  status: OrchestratorStatus;
  /** The tmux session it was last seen in. */
  session: string | null;
  /** When `status` last changed; null while `unknown`. */
  since: string | null;
}

/** The last board or brief the runner could not parse (D4), until a newer round parses. */
export interface BoardErrorView {
  file: string;
  line: number | null;
  reason: string;
  at: string;
}

/** `GET /projects/:id/fleet`. */
export interface FleetView {
  projectId: string;
  orchestrator: OrchestratorView;
  /** The latest round's base, else the project's base branch. */
  base: string;
  latestRound: RoundHeader | null;
  boardError: BoardErrorView | null;
  /** Every slot whose status is not `ended`, newest first. */
  slots: SlotSummary[];
}

export const FLEET_SLOTS_PAGE_DEFAULT = 50;
export const FLEET_SLOTS_PAGE_MAX = 200;
export const FLEET_ROUNDS_MAX = 100;

/** `GET /projects/:id/slots` — newest first; pass `nextCursor` as `cursor`. */
export interface SlotPage {
  items: SlotSummary[];
  nextCursor: string | null;
}

/** Live event name on topic `project:<id>` (D9). Clients refetch on it. */
export const FLEET_LIVE_EVENT = 'fleet';

export interface FleetLiveChange {
  kind: 'slot' | 'round' | 'orchestrator';
  /** The slot or round id; the project id for `orchestrator`. */
  id: string;
}

/** Stable codes in the `error` field of a fleet route's error body. */
export const FLEET_ERROR = {
  slotNotFound: 'slot_not_found',
} as const;
export type FleetErrorCode = (typeof FLEET_ERROR)[keyof typeof FLEET_ERROR];
