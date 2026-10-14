import type { ConfigService } from '@nestjs/config';

/** Timings of the workflows projector and read cache (#161). */
export interface WorkflowsOptions {
  /** Poll interval of the projector loop. */
  pollMs: number;
  /** How long a computed response is served again; 0 turns the cache off. */
  cacheTtlMs: number;
  /** Whether the loop starts on bootstrap: never under `APP_ENV=test`. */
  loop: boolean;
}

export const WORKFLOWS_OPTIONS = Symbol('WORKFLOWS_OPTIONS');

/**
 * `WORKFLOW_FRESHNESS_MS` (shared) is the sum of the two: keep it in step.
 * Every e2e suite boots the whole app; a background writer would race their
 * TRUNCATEs, so tests drive `tick()` themselves.
 */
export const workflowsOptions = (config: ConfigService): WorkflowsOptions => ({
  pollMs: 5_000,
  cacheTtlMs: 30_000,
  loop: config.get<string>('APP_ENV') !== 'test',
});
