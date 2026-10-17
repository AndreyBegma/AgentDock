import { Injectable, Optional } from '@nestjs/common';
import type { Schedule, ScheduleFiring } from '@prisma/client';
import { BudgetGate, type BudgetGateResult } from '../budgets/budget-gate';

export type BeforeFireDecision =
  | { allow: true }
  | {
      allow: false;
      reason: string;
      /** The gate's refusal, for run now's 409 `budget_exceeded`. */
      budget: Extract<BudgetGateResult, { allowed: false }>;
    };

/** The reason a refused budget gate gives the denied firing. */
export const BEFORE_FIRE_BUDGET_REASON = 'budget';

/**
 * D12: the one pre-fire hook. A budget (#28) refusal denies the firing, which
 * is recorded `skipped` with its reason — not `failed`, so it never counts
 * toward `consecutiveFailures` and never auto-disables the schedule. The gate
 * is asked for the firing's principal (D-10): the owner for a timed firing,
 * the caller for run now — so their user budget holds as it does for a run
 * they start by hand. Without `BudgetsModule` the gate is absent and
 * everything is allowed (spec 28 D11).
 */
@Injectable()
export class BeforeFire {
  constructor(@Optional() private readonly budgets?: BudgetGate) {}

  async check(
    schedule: Schedule,
    _firing: ScheduleFiring,
    principalId: string,
  ): Promise<BeforeFireDecision> {
    const gate = await this.budgets?.check({
      projectId: schedule.projectId,
      userId: principalId,
    });
    if (gate && !gate.allowed) {
      return { allow: false, reason: BEFORE_FIRE_BUDGET_REASON, budget: gate };
    }
    return { allow: true };
  }
}
