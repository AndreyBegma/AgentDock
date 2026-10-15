import type { TaskDesignStatus } from '@agentdock/shared';
import type { TaskDesign } from '@prisma/client';
import type { PlanActor } from '../planner/plan.service';
import type { PlanCaller } from '../planner/plan-turn.service';
import type { DesignTurnPlan } from './design-rules';
import type { DesignKey } from './design-store';

/**
 * ADR-0025 / #243 D3: a design's owner — a plan task or a board card — as
 * `DesignService` drives it. One module, two hosts: the stage's rules
 * (switch, Generate, comments, Revise, Approve) are the service's; what
 * differs by host is here. An owner is built only once its host is known
 * open for the operation (`assertOpen`), so holding one is the proof.
 */
export interface DesignOwner {
  kind: 'task' | 'card';
  /** The `task_designs` row's owner key. */
  key: DesignKey;
  projectId: string;
  /** The audit target of `design.*` (D10). */
  target: { type: 'plan' | 'board_card'; id: string };
  /** What names the owner in an audit record's `before` / `after`. */
  label: { key: string } | { number: number };
  /** D1 for a task: its status follows its design. A card has none. */
  gate(design: Pick<TaskDesign, 'needed' | 'status'>): Promise<void>;
  /** 409 when a turn of the owner's host is queued or running. */
  assertIdle(): Promise<void>;
  /** The first turn of a batch (D4, D10). Returns the turn id. */
  runTurn(batch: DesignTurnPlan, caller: PlanCaller): Promise<string>;
  /** After the approval committed: a task chains its write; a card closes (#243 D6, D7). */
  onApproved(
    design: Pick<TaskDesign, 'needed' | 'status'>,
    actor: PlanActor,
  ): Promise<void>;
  /** The live push of a change. */
  publish(): void;
}

/** A design's status while a turn or a profile build of it runs. */
export const busyStatusOf = (mode: DesignTurnPlan['mode']): TaskDesignStatus =>
  mode === 'generate' ? 'generating' : 'revising';
