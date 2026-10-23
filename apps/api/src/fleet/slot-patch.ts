import type { PaneState, PrState } from '@nautelle/shared';
import {
  type CheckpointKind,
  isAdvisorySource,
  type PrChecks,
  type SlotRuntime,
} from '@nautelle/shared/protocol';
import type { Applied } from './projection';

/** The columns a slot event may set; `status` and `endedAt` follow from them. */
export interface SlotPatch {
  issue?: number;
  branch?: string;
  worktree?: string;
  runtime?: SlotRuntime;
  model?: string | null;
  modelWhy?: string | null;
  owns?: string[];
  never?: string[];
  lead?: boolean | null;
  round?: string;
  sessionAlive?: boolean;
  pane?: PaneState | null;
  /** The limit the quota banner names, and when it resets (spec 741 D3). */
  quotaLimit?: string | null;
  quotaResetsAt?: Date | null;
  worktreeExists?: boolean;
  ahead?: number | null;
  behind?: number | null;
  dirty?: boolean | null;
  prNumber?: number;
  prUrl?: string;
  prState?: PrState;
  prChecks?: PrChecks;
  prMergeable?: boolean | null;
  lastCheckpoint?: CheckpointKind;
}

/** Spec 16 D7: the columns of each field group the plugin reports. */
export const SLOT_GROUPS = {
  model: ['model', 'modelWhy', 'owns', 'never', 'lead'],
  checkpoint: ['lastCheckpoint'],
  pr: ['prNumber', 'prUrl', 'prState', 'prChecks', 'prMergeable'],
} as const satisfies Record<string, readonly (keyof SlotPatch)[]>;

/** What a run is written from: a slot event, or a slot of a snapshot (D6). */
export type RunSource = Pick<Applied, 'ts' | 'seq'> & {
  source: Applied['event']['source'];
  issue?: number;
};

export const sourceOf = (applied: Applied): RunSource => ({
  ts: applied.ts,
  seq: applied.seq,
  source: applied.event.source,
  issue: applied.event.issue,
});

/**
 * C-169: an event the agents can write (`isAdvisorySource`) may name a slot's
 * pull request, never its merge or check state — those come from the runner's
 * own `gh` observations only. The approvals sink reads that state, so a
 * forged `pr.merged` or green `pr.checks_changed` moves no approval either.
 */
export const withoutAdvisoryPrState = (
  source: RunSource['source'],
  patch: SlotPatch,
): SlotPatch => {
  if (!isAdvisorySource(source)) return patch;
  const {
    prState: _prState,
    prChecks: _prChecks,
    prMergeable: _prMergeable,
    ...rest
  } = patch;
  return rest;
};

export const PANE_OF = {
  'pane.prompt': 'prompt',
  'pane.idle': 'idle',
  'pane.quota_hit': 'quota',
  'pane.busy': 'busy',
} as const satisfies Record<string, PaneState>;
