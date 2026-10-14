import { describe, expect, test } from 'bun:test';
import {
  DESIGN_ERROR,
  TASK_DESIGN_STATUSES,
  type TaskDesignSummary,
  UI_PROFILE_STATUSES,
} from '@agentdock/shared';
import { STATUSES } from '@andrewbehma/glass-ui/status-pill';
import { ApiError } from '../api';
import { task } from '../planner/fixtures';
import {
  canToggleDesign,
  DESIGN_STATUS_PILL,
  describeDesignError,
  designChipState,
  opensDesign,
  PROFILE_STATUS_PILL,
  toggleBehindMenu,
} from './format';

const summary = (over: Partial<TaskDesignSummary> = {}): TaskDesignSummary => ({
  needed: false,
  suggested: false,
  suggestionWhy: null,
  variantCount: 1,
  status: 'idle',
  approvedRevisionId: null,
  ...over,
});

/** A task whose design row has these fields. */
const withDesign = (over: Partial<TaskDesignSummary> = {}) =>
  task({ design: summary(over) });

describe('the Design chip', () => {
  test('off, suggested, on, approved', () => {
    expect(designChipState(task())).toBe('off');
    expect(designChipState(withDesign())).toBe('off');
    expect(designChipState(withDesign({ suggested: true }))).toBe('suggested');
    expect(designChipState(withDesign({ suggested: true, needed: true }))).toBe(
      'on',
    );
    expect(
      designChipState(withDesign({ needed: true, status: 'approved' })),
    ).toBe('approved');
  });

  test('D3: a project without UI hides the toggle behind "Design anyway"', () => {
    expect(toggleBehindMenu(task(), false)).toBe(true);
    expect(toggleBehindMenu(task(), null)).toBe(false);
    expect(toggleBehindMenu(task(), true)).toBe(false);
    // Already on: the toggle stays in reach to switch it off.
    expect(toggleBehindMenu(withDesign({ needed: true }), false)).toBe(false);
  });

  test('a needs_design task opens its design', () => {
    expect(opensDesign(task({ status: 'needs_design' }))).toBe(true);
    expect(opensDesign(task())).toBe(false);
  });

  test('the toggle closes once the task or its design is approved, or a turn runs', () => {
    expect(canToggleDesign(task())).toBe(true);
    expect(canToggleDesign(task({ status: 'approved' }))).toBe(false);
    expect(canToggleDesign(task({ frozen: true }))).toBe(false);
    expect(
      canToggleDesign(withDesign({ status: 'generating', needed: true })),
    ).toBe(false);
  });
});

describe('status pills', () => {
  test('every status maps onto the glass-ui scale', () => {
    for (const s of TASK_DESIGN_STATUSES) {
      expect(STATUSES).toContain(DESIGN_STATUS_PILL[s]);
    }
    for (const s of UI_PROFILE_STATUSES) {
      expect(STATUSES).toContain(PROFILE_STATUS_PILL[s]);
    }
  });
});

describe('describeDesignError', () => {
  const refused = (status: number, error?: string) =>
    new ApiError(status, undefined, 'raw', undefined, error ? { error } : null);

  test('every code has its own sentence, never the raw message', () => {
    for (const code of Object.values(DESIGN_ERROR)) {
      const described = describeDesignError(refused(409, code), 'p1');
      const text = typeof described === 'string' ? described : described.text;
      expect(text).not.toBe('raw');
    }
  });

  test('a budget stop links the budget', () => {
    expect(describeDesignError(refused(409, 'budget_exceeded'), 'p1')).toEqual({
      text: expect.any(String),
      href: '/projects/p1/settings?tab=budget',
      cta: 'Open budget',
    });
  });

  test('status codes without a body, and the network', () => {
    expect(describeDesignError(refused(404))).toMatch(/does not exist/);
    expect(describeDesignError(refused(403))).toMatch(/role/);
    expect(describeDesignError(refused(500))).toBe('raw');
    expect(describeDesignError(new Error('x'))).toMatch(/connection/);
  });
});
