import { describe, expect, test } from 'bun:test';
import type { PlanSummary } from '@nautelle/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { type PlanRetry, planColumns } from './plan-list';

const plan = (attention: PlanSummary['attention']): PlanSummary =>
  ({
    id: 'pl1',
    projectId: 'p1',
    title: 'Ship it',
    author: { name: 'Ann' },
    mode: 'batch',
    version: 1,
    visibility: 'shared',
    status: 'drafting',
    taskCounts: {},
    attention,
  }) as unknown as PlanSummary;

const failed = {
  kind: 'failed' as const,
  reason: 'boom',
  turnId: 't1',
  at: '2026-10-15T00:00:00Z',
};

const planCell = (row: PlanSummary, retry?: PlanRetry) => {
  const cell = planColumns(retry)[0]?.cell(row);
  return renderToStaticMarkup(<div>{cell}</div>);
};

const retry = (allowed: boolean): PlanRetry => ({
  allowed,
  retrying: null,
  onRetry: () => {},
});

describe('PlanList', () => {
  test('a failed plan offers Retry to an operator', () => {
    expect(planCell(plan(failed), retry(true))).toContain('Retry');
  });

  test('a viewer reads the reason and gets no Retry', () => {
    const html = planCell(plan(failed), retry(false));
    expect(html).toContain('boom');
    expect(html).not.toContain('Retry');
  });

  test('a plan that merely needs attention has no Retry', () => {
    const html = planCell(plan({ ...failed, kind: 'attention' }), retry(true));
    expect(html).not.toContain('Retry');
  });

  test('the plan column takes the slack and lets a long title wrap (C-301)', () => {
    const [first] = planColumns();
    expect(first?.width).toBe('100%');
    const html = planCell({ ...plan(null), title: 'x'.repeat(200) });
    expect(html).toContain('whitespace-normal');
    expect(html).toContain('wrap-anywhere');
    expect(html).not.toContain('truncate');
  });
});
