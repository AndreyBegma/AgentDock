import { describe, expect, test } from 'bun:test';
import type { BudgetView } from '@agentdock/shared';
import { ApiError } from '../api';
import {
  budgetExceededOf,
  budgetFormProblem,
  describeBudgetExceededError,
  describeBudgetsError,
  emptyBudgetForm,
  formatBudgetUsd,
  formatLimit,
  formatPercent,
  formFromBudget,
  overrideProblem,
  parseThresholds,
  refusingBudget,
  spendLabel,
  toAdminCreateRequest,
  toCreateRequest,
  toUpdateRequest,
  unpricedHint,
} from './format';

const budget = (overrides: Partial<BudgetView> = {}): BudgetView => ({
  id: 'b1',
  scope: 'project',
  projectId: 'p1',
  userId: null,
  scopeName: 'Alpha',
  period: 'day',
  timezone: 'Europe/Berlin',
  limitUsd: '10.0000',
  thresholds: [50, 80, 100],
  action: 'stop',
  enabled: true,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  current: {
    start: '2026-10-09T22:00:00.000Z',
    end: '2026-10-10T22:00:00.000Z',
    spentUsd: '3.200000',
    percent: 32,
    unpricedRequests: 0,
    firedThresholds: [],
    exceededAt: null,
    state: 'ok',
  },
  override: null,
  ...overrides,
});

const exceeded409 = (scope = 'project') =>
  new ApiError(409, undefined, 'budget exceeded', undefined, {
    statusCode: 409,
    error: 'budget_exceeded',
    budgetId: 'b1',
    scope,
    resetsAt: '2026-10-10T22:00:00.000Z',
  });

describe('money and labels', () => {
  test('formats dollars', () => {
    expect(formatBudgetUsd('3.2')).toBe('$3.20');
    expect(formatBudgetUsd('1234.5')).toBe('$1,234.50');
    expect(formatLimit('10.0000')).toBe('$10.00');
    expect(formatLimit('0.0125')).toBe('$0.0125');
    expect(formatBudgetUsd('x')).toBe('—');
  });

  test('formats percent', () => {
    expect(formatPercent(32)).toBe('32 %');
    expect(formatPercent(32.5)).toBe('32.5 %');
    expect(formatPercent(120)).toBe('120 %');
  });

  test('spend label and unpriced hint', () => {
    expect(spendLabel(budget())).toBe('$3.20 of $10.00 (32 %)');
    expect(spendLabel(budget({ current: null }))).toContain('Disabled');
    expect(unpricedHint(0)).toBeUndefined();
    expect(unpricedHint(1)).toBe('1 unpriced request');
    expect(unpricedHint(4)).toBe('4 unpriced requests');
  });
});

describe('refusingBudget', () => {
  const over = (action: 'alert' | 'stop', state: 'exceeded' | 'overridden') =>
    budget({
      action,
      current: { ...(budget().current as never), state, percent: 120 },
    });

  test('only an enabled, exceeded stop budget refuses', () => {
    expect(refusingBudget([budget()])).toBeUndefined();
    expect(refusingBudget([over('alert', 'exceeded')])).toBeUndefined();
    expect(refusingBudget([over('stop', 'overridden')])).toBeUndefined();
    expect(refusingBudget([over('stop', 'exceeded'), budget()])?.id).toBe('b1');
    expect(
      refusingBudget([{ ...over('stop', 'exceeded'), enabled: false }]),
    ).toBeUndefined();
  });
});

describe('thresholds and the form', () => {
  test('parses, sorts and keeps 100', () => {
    expect(parseThresholds('80, 50')).toEqual([50, 80, 100]);
    expect(parseThresholds('')).toEqual([100]);
    expect(parseThresholds('50 80')).toEqual([50, 80, 100]);
    expect(parseThresholds('abc')).toBeNull();
    expect(parseThresholds('50.5')).toBeNull();
    expect(parseThresholds('0')).toBeNull();
    expect(parseThresholds('101')).toBeNull();
  });

  test('validates the form', () => {
    const form = { ...emptyBudgetForm('Europe/Berlin'), limit: '10' };
    expect(budgetFormProblem(form, false)).toBeNull();
    expect(budgetFormProblem(form, true)).toBe('scope_target');
    expect(budgetFormProblem({ ...form, projectId: 'p1' }, true)).toBeNull();
    expect(budgetFormProblem({ ...form, scope: 'user' }, true)).toBe(
      'scope_target',
    );
    expect(budgetFormProblem({ ...form, limit: '' }, false)).toBe('limit');
    expect(budgetFormProblem({ ...form, limit: '1.23456' }, false)).toBe(
      'limit',
    );
    expect(budgetFormProblem({ ...form, limit: '0' }, false)).toBe(
      'limit_zero',
    );
    expect(budgetFormProblem({ ...form, thresholds: '9x' }, false)).toBe(
      'thresholds',
    );
    expect(budgetFormProblem({ ...form, timezone: 'Mars/Base' }, false)).toBe(
      'timezone',
    );
  });

  test('builds the create bodies', () => {
    const form = {
      ...emptyBudgetForm('UTC'),
      limit: ' 10 ',
      thresholds: '80',
      action: 'stop' as const,
      projectId: 'p1',
    };
    expect(toCreateRequest(form)).toEqual({
      period: 'month',
      timezone: 'UTC',
      limitUsd: '10',
      thresholds: [80, 100],
      action: 'stop',
      enabled: true,
    });
    expect(toAdminCreateRequest(form)).toMatchObject({
      scope: 'project',
      projectId: 'p1',
    });
    expect(
      toAdminCreateRequest({ ...form, scope: 'user', userId: 'u1' }),
    ).toMatchObject({ scope: 'user', userId: 'u1' });
    expect(
      'projectId' in
        toAdminCreateRequest({ ...form, scope: 'user', userId: 'u1' }),
    ).toBe(false);
  });

  test('an edit patch carries only what changed', () => {
    const b = budget();
    const form = formFromBudget(b);
    expect(form.limit).toBe('10');
    expect(toUpdateRequest(form, b)).toEqual({});
    expect(toUpdateRequest({ ...form, limit: '25.50' }, b)).toEqual({
      limitUsd: '25.50',
    });
    expect(toUpdateRequest({ ...form, enabled: false }, b)).toEqual({
      enabled: false,
    });
    expect(toUpdateRequest({ ...form, thresholds: '90' }, b)).toEqual({
      thresholds: [90, 100],
    });
  });
});

describe('override form', () => {
  const now = new Date('2026-10-10T10:00:00.000Z');
  const b = budget();
  const at = (iso: string) => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  test('needs a time inside the period and a reason', () => {
    expect(overrideProblem({ until: '', reason: 'x' }, b, now)).toBe('until');
    expect(
      overrideProblem(
        { until: at('2026-10-10T09:00:00Z'), reason: 'x' },
        b,
        now,
      ),
    ).toBe('until_range');
    expect(
      overrideProblem(
        { until: at('2026-10-11T09:00:00Z'), reason: 'x' },
        b,
        now,
      ),
    ).toBe('until_range');
    expect(
      overrideProblem(
        { until: at('2026-10-10T12:00:00Z'), reason: ' ' },
        b,
        now,
      ),
    ).toBe('reason');
    expect(
      overrideProblem(
        { until: at('2026-10-10T12:00:00Z'), reason: 'ok' },
        b,
        now,
      ),
    ).toBeNull();
  });
});

describe('budget_exceeded', () => {
  test('is read from the 409 body', () => {
    expect(budgetExceededOf(exceeded409())).toEqual({
      budgetId: 'b1',
      scope: 'project',
      resetsAt: '2026-10-10T22:00:00.000Z',
    });
    expect(budgetExceededOf(exceeded409('user'))?.scope).toBe('user');
  });

  test('ignores every other error', () => {
    expect(budgetExceededOf(new Error('x'))).toBeNull();
    expect(
      budgetExceededOf(new ApiError(409, undefined, 'already running')),
    ).toBeNull();
    expect(
      budgetExceededOf(
        new ApiError(409, undefined, 'x', undefined, { error: 'other' }),
      ),
    ).toBeNull();
    expect(
      budgetExceededOf(
        new ApiError(500, undefined, 'x', undefined, {
          error: 'budget_exceeded',
          budgetId: 'b',
          resetsAt: 'z',
        }),
      ),
    ).toBeNull();
  });

  test('is a sentence naming the reset and that work continues', () => {
    const text = describeBudgetExceededError(exceeded409());
    expect(text).toContain('This project’s budget');
    expect(text).toContain('Running work continues');
    expect(describeBudgetExceededError(exceeded409('user'))).toContain(
      'Your budget',
    );
    expect(describeBudgetExceededError(new Error('x'))).toBeNull();
  });
});

describe('describeBudgetsError', () => {
  test('maps codes and statuses', () => {
    expect(
      describeBudgetsError(
        new ApiError(409, 'budget_duplicate' as never, 'dup'),
      ),
    ).toContain('same scope and period');
    expect(describeBudgetsError(new ApiError(403, undefined, 'x'))).toContain(
      'role',
    );
    expect(describeBudgetsError(new ApiError(404, undefined, 'x'))).toContain(
      'no longer exists',
    );
    expect(describeBudgetsError(exceeded409())).toContain('used up');
  });
});
