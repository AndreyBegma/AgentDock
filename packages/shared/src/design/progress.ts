/**
 * Progress and failure of a long design run (#275 D1, D6): what a busy
 * design is doing, and why the last batch ended without a revision.
 */

/** D1: the build of the UI profile, or a design turn drawing or revising a variant. */
export const DESIGN_PROGRESS_STAGES = ['profile', 'draw', 'revise'] as const;
export type DesignProgressStage = (typeof DESIGN_PROGRESS_STAGES)[number];

/** A queued run waits for a free runner slot; only a running one can stall (D4). */
export const DESIGN_PROGRESS_PHASES = ['queued', 'running'] as const;
export type DesignProgressPhase = (typeof DESIGN_PROGRESS_PHASES)[number];

/** A batch is a Generate or a Revise; Retry repeats the failed one's mode (D6). */
export const DESIGN_BATCH_MODES = ['generate', 'revise'] as const;
export type DesignBatchMode = (typeof DESIGN_BATCH_MODES)[number];

/** D6: how the last batch ended. */
export const DESIGN_FAILURE_REASONS = [
  'timed_out',
  'failed',
  'stopped',
] as const;
export type DesignFailureReason = (typeof DESIGN_FAILURE_REASONS)[number];

/**
 * The runner's fixed timeout sentence (`apps/runner/src/planner/result.ts`):
 * `the turn exceeded its <n> s timeout`.
 */
const TIMEOUT_ERROR = /\bexceeded its \d+ s timeout\b/;

/**
 * D6: `stopped` for a cancelled turn or an abandoned build, `timed_out` when
 * the error is the runner's timeout sentence, else `failed`.
 */
export const designFailureReasonOf = (
  error: string | null | undefined,
  cancelled = false,
): DesignFailureReason => {
  if (cancelled) return 'stopped';
  if (error && TIMEOUT_ERROR.test(error)) return 'timed_out';
  return 'failed';
};
