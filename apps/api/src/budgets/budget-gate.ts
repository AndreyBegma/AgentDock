import type { BudgetScope } from '@nautelle/shared';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { BudgetExceededError } from './budget-error';
import { BudgetEvaluator } from './budget-evaluator';

export interface BudgetGateInput {
  projectId: string;
  /**
   * The person starting it — for a schedule firing, its principal (D-10);
   * null for a webhook or Nautelle's own work (D3).
   */
  userId: string | null;
}

export type BudgetGateResult =
  | { allowed: true }
  | { allowed: false; budgetId: string; scope: BudgetScope; resetsAt: Date };

/**
 * The D11 contract: whether new spend may start for a project and a user.
 * Every start that spends calls it once before a runner command is sent:
 * #17's orchestrator start/next, #24's skill runs, schedule firings, board
 * rounds, plan and design turns and UI profile builds (D-10). Only enabled
 * `stop` budgets refuse, and only while their current period has reached
 * 100 % with no active override (D7, D8). Each budget is evaluated fresh, so the gate has no detection lag.
 * It never stops, kills or messages anything that is already running.
 */
@Injectable()
export class BudgetGate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly evaluator: BudgetEvaluator,
  ) {}

  async check(input: BudgetGateInput): Promise<BudgetGateResult> {
    const budgets = await this.prisma.budget.findMany({
      where: {
        enabled: true,
        action: 'stop',
        OR: [
          { scope: 'project', projectId: input.projectId },
          ...(input.userId
            ? [{ scope: 'user' as const, userId: input.userId }]
            : []),
        ],
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const { id } of budgets) {
      const e = await this.evaluator.evaluate(id);
      if (e?.exceeded && !e.overrideActive) {
        return {
          allowed: false,
          budgetId: e.budget.id,
          scope: e.budget.scope,
          resetsAt: e.row.end,
        };
      }
    }
    return { allowed: true };
  }

  /** `check`, throwing the 409 `budget_exceeded` on a refusal. */
  async assertAllowed(input: BudgetGateInput): Promise<void> {
    const result = await this.check(input);
    if (!result.allowed) {
      throw new BudgetExceededError(
        result.budgetId,
        result.scope,
        result.resetsAt,
      );
    }
  }
}
