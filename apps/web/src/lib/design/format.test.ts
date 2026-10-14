import { describe, expect, test } from 'bun:test';
import {
  DESIGN_ERROR,
  TASK_DESIGN_STATUSES,
  type TaskDesignSummary,
  UI_PROFILE_STATUSES,
} from '@agentdock/shared';
import { STATUSES } from '@andrewbehma/glass-ui/status-pill';
import { ApiError } from '../api';
import { card, round } from '../board/fixtures';
import { task } from '../planner/fixtures';
import {
  canChangeContinue,
  canToggleCardDesign,
  canToggleDesign,
  cardDesignChipState,
  DESIGN_STATUS_PILL,
  describeDesignError,
  designChipState,
  generateRunnerGate,
  opensCardDesign,
  opensDesign,
  PROFILE_STATUS_PILL,
  rebuildRunnerGate,
  toggleBehindMenu,
} from './format';

describe('the Design chip on a board card (#243)', () => {
  const summary = (over: Partial<TaskDesignSummary>): TaskDesignSummary => ({
    needed: true,
    suggested: false,
    suggestionWhy: null,
    variantCount: 2,
    status: 'idle',
    approvedRevisionId: null,
    ...over,
  });

  test('every status has a state, and off is a card without a design', () => {
    expect(cardDesignChipState(null)).toBe('off');
    expect(cardDesignChipState(summary({ needed: false }))).toBe('off');
    expect(cardDesignChipState(summary({ status: 'idle' }))).toBe('on');
    expect(cardDesignChipState(summary({ status: 'generating' }))).toBe(
      'generating',
    );
    expect(cardDesignChipState(summary({ status: 'revising' }))).toBe(
      'generating',
    );
    expect(cardDesignChipState(summary({ status: 'reviewing' }))).toBe(
      'reviewing',
    );
    expect(cardDesignChipState(summary({ status: 'approved' }))).toBe(
      'approved',
    );
  });

  test('the design and the switch freeze with the first round', () => {
    const open = card(1, 'todo');
    expect(canToggleCardDesign(open)).toBe(true);
    expect(canChangeContinue(open)).toBe(true);
    const running = card(1, 'in_progress', { round: round('running') });
    expect(canToggleCardDesign(running)).toBe(false);
    expect(canChangeContinue(running)).toBe(false);
  });

  test('approval freezes the design; a running turn freezes only the toggle', () => {
    const approved = card(1, 'todo', {
      design: summary({ status: 'approved' }),
    });
    expect(canToggleCardDesign(approved)).toBe(false);
    expect(canChangeContinue(approved)).toBe(false);
    const drawing = card(1, 'todo', {
      design: summary({ status: 'generating' }),
    });
    expect(canToggleCardDesign(drawing)).toBe(false);
    expect(canChangeContinue(drawing)).toBe(true);
  });

  test('Open design once the design is on or approved', () => {
    expect(opensCardDesign(null)).toBe(false);
    expect(opensCardDesign(summary({ needed: false }))).toBe(false);
    expect(opensCardDesign(summary({}))).toBe(true);
    expect(
      opensCardDesign(summary({ needed: false, status: 'approved' })),
    ).toBe(true);
  });
});

describe('runner gates (#233)', () => {
  const ALL = ['plan.turn', 'uiprofile.build', 'uiprofile.fingerprint'];
  const online = (commands: string[], disabled: string[] = []) => ({
    runnerStatus: 'online' as const,
    runnerCommands: { commands, disabled },
  });

  test('Generate needs plan.turn and both UI profile commands', () => {
    expect(generateRunnerGate(online(ALL))).toBeNull();
    expect(generateRunnerGate(online(['plan.turn']))).toBe('outdated');
    expect(generateRunnerGate(online(ALL, ['uiprofile.fingerprint']))).toBe(
      'disabled',
    );
  });

  test('Build / Rebuild needs only uiprofile.build', () => {
    expect(rebuildRunnerGate(online(['uiprofile.build']))).toBeNull();
    expect(rebuildRunnerGate(online(['plan.turn']))).toBe('outdated');
    expect(rebuildRunnerGate(online(ALL, ['uiprofile.build']))).toBe(
      'disabled',
    );
  });

  test('unknown or offline: no gate, the runner’s answer decides', () => {
    const unknown = { runnerStatus: 'online' as const, runnerCommands: null };
    expect(generateRunnerGate(unknown)).toBeNull();
    expect(rebuildRunnerGate(unknown)).toBeNull();
    expect(
      rebuildRunnerGate({
        runnerStatus: 'offline',
        runnerCommands: { commands: [], disabled: [] },
      }),
    ).toBeNull();
  });
});

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

  test('an old runner links the update (#233)', () => {
    for (const code of ['runner_outdated', 'command_unavailable']) {
      expect(describeDesignError(refused(409, code), 'p1')).toEqual({
        text: expect.any(String),
        href: '/install',
        cta: 'Update the runner',
      });
    }
  });

  test('status codes without a body, and the network', () => {
    expect(describeDesignError(refused(404))).toMatch(/does not exist/);
    expect(describeDesignError(refused(403))).toMatch(/role/);
    expect(describeDesignError(refused(500))).toBe('raw');
    expect(describeDesignError(new Error('x'))).toMatch(/connection/);
  });
});
