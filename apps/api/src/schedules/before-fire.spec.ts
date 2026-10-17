import type { Schedule, ScheduleFiring } from '@prisma/client';
import type { BudgetGate, BudgetGateResult } from '../budgets/budget-gate';
import { BEFORE_FIRE_BUDGET_REASON, BeforeFire } from './before-fire';

const schedule = { id: 's1', projectId: 'p1' } as Schedule;
const firing = { id: 1n } as ScheduleFiring;

const gate = (result: BudgetGateResult) => {
  const check = jest.fn().mockResolvedValue(result);
  return { check, hook: new BeforeFire({ check } as unknown as BudgetGate) };
};

describe('BeforeFire', () => {
  it('allows when the budget gate allows, asking it for the firing’s principal (D-10)', async () => {
    const { check, hook } = gate({ allowed: true });
    await expect(hook.check(schedule, firing, 'u1')).resolves.toEqual({
      allow: true,
    });
    expect(check).toHaveBeenCalledWith({ projectId: 'p1', userId: 'u1' });
  });

  it('denies with reason budget when the gate refuses', async () => {
    const refusal = {
      allowed: false as const,
      budgetId: 'b1',
      scope: 'user' as const,
      resetsAt: new Date('2026-10-10T00:00:00Z'),
    };
    const { hook } = gate(refusal);
    await expect(hook.check(schedule, firing, 'u1')).resolves.toEqual({
      allow: false,
      reason: BEFORE_FIRE_BUDGET_REASON,
      budget: refusal,
    });
    expect(BEFORE_FIRE_BUDGET_REASON).toBe('budget');
  });

  it('allows when there is no budget gate', async () => {
    await expect(
      new BeforeFire().check(schedule, firing, 'u1'),
    ).resolves.toEqual({
      allow: true,
    });
  });
});
