import type {
  PlanAttention,
  PlanStatus,
  PlanTurnPhase,
} from '@agentdock/shared';

/** The fields of a `plan_turns` row the derivation reads. */
export interface PlanStatusTurn {
  id: string;
  phase: PlanTurnPhase;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

/** Statuses with work still ahead of the planner or the person. */
const OPEN: ReadonlySet<PlanStatus> = new Set([
  'clarifying',
  'drafting',
  'reviewing',
]);

/**
 * #213: a failed plan must not read as "Drafting". `latestTurn` is the plan's
 * newest turn of any scope (`createdAt desc, id desc`); when it failed,
 * nothing newer has replaced it, so the plan waits on a retry. Before
 * decomposition (clarifying, drafting) the plan made no progress — `failed`;
 * with tasks to review it is a task turn that failed — `attention`. A sending,
 * sent or archived plan takes no more turns and needs nothing.
 */
export function planAttention(
  status: PlanStatus,
  latestTurn: PlanStatusTurn | null,
): PlanAttention | null {
  if (!OPEN.has(status) || latestTurn?.phase !== 'failed') return null;
  return {
    kind: status === 'reviewing' ? 'attention' : 'failed',
    reason: latestTurn.error ?? 'The runner gave no reason.',
    turnId: latestTurn.id,
    at: (latestTurn.finishedAt ?? latestTurn.createdAt).toISOString(),
  };
}
