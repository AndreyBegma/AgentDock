import { Injectable, Optional } from '@nestjs/common';
import type { Schedule, ScheduleFiring } from '@prisma/client';
import { BudgetGate } from '../budgets/budget-gate';

export type BeforeFireDecision =
  | { allow: true }
  | { allow: false; reason: string };

/** The reason a refused budget gate gives the denied firing. */
export const BEFORE_FIRE_BUDGET_REASON = 'budget';

/**
 * D12: the one pre-fire hook. A budget (#28) refusal denies the firing, which
 * is recorded `skipped` with its reason — not `failed`, so it never counts
 * toward `consecutiveFailures` and never auto-disables the schedule. A
 * schedule has no person behind it, so the gate is asked with `userId: null`
 * (spec 28 D3). Without `BudgetsModule` the gate is absent and everything is
 * allowed (spec 28 D11).
 */
@Injectable()
export class BeforeFire {
  constructor(@Optional() private readonly budgets?: BudgetGate) {}

  async check(
    schedule: Schedule,
    _firing: ScheduleFiring,
  ): Promise<BeforeFireDecision> {
    const gate = await this.budgets?.check({
      projectId: schedule.projectId,
      userId: null,
    });
    if (gate && !gate.allowed) {
      return { allow: false, reason: BEFORE_FIRE_BUDGET_REASON };
    }
    return { allow: true };
  }
}
