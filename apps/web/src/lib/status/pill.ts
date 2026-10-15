import type {
  OrchestratorStatus,
  QueueState,
  RunStatus,
  SlotStatus,
} from '@agentdock/shared';
import type { SkillRunPhase } from '@agentdock/shared/protocol';
import type { Status } from '@andrewbehma/glass-ui/status-pill';

/**
 * What a running thing is doing now, on glass-ui's status scale (#163,
 * glass-ui#109): `StatusPill` and `StatusDot` read `--color-status-*` from it,
 * so a slot, a run and an orchestrator in the same state wear the same colour.
 * The wording stays ours — pass the domain label to the pill.
 */
export const SLOT_PILL_STATUS: Record<SlotStatus, Status> = {
  // The brief exists; the session has not appeared yet.
  dispatched: 'waiting',
  running: 'running',
  idle: 'idle',
  // A launch dialog waits on a person.
  prompt: 'blocked',
  // The quota banner: it resumes by itself when the window resets.
  quota: 'paused',
  // The session died with the PR unmerged.
  stale: 'error',
  ended: 'done',
};

export const RUN_PILL_STATUS: Record<RunStatus, Status> = {
  running: 'running',
  blocked: 'blocked',
  waiting_person: 'waiting',
  succeeded: 'done',
  failed: 'error',
  abandoned: 'idle',
};

export const ORCHESTRATOR_PILL_STATUS: Record<OrchestratorStatus, Status> = {
  running: 'running',
  idle: 'idle',
  absent: 'paused',
  unknown: 'idle',
};

/** Where an issue stands in the queue (spec 19), as process state (#213). */
export const QUEUE_PILL_STATUS: Record<QueueState, Status> = {
  in_flight: 'running',
  // Ready to dispatch: it waits for a slot.
  ready: 'waiting',
  // It resumes by itself once the work it depends on lands.
  blocked_work: 'paused',
  blocked_person: 'blocked',
  no_spec: 'idle',
};

/** A skill run's phase (spec D12). */
export const SKILL_PILL_STATUS: Record<SkillRunPhase, Status> = {
  queued: 'waiting',
  preparing: 'running',
  running: 'running',
  collecting: 'running',
  succeeded: 'done',
  failed: 'error',
  timed_out: 'error',
  cancelled: 'idle',
};
