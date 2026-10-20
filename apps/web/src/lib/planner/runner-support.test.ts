import { describe, expect, test } from 'bun:test';
import type { RunnerCommands } from '@nautelle/shared/protocol';
import { turn } from './fixtures';
import { RUNNER_TOO_OLD_TEXT } from './format';
import {
  failedTurnCopy,
  plannerRunnerBlock,
  RUNNER_UPDATE_HREF,
  type RunnerFacts,
  runnerGate,
  runnerGateCopy,
  runnerSupport,
} from './runner-support';

const ALL = ['plan.turn', 'uiprofile.build', 'uiprofile.fingerprint'];

const project = (
  runnerCommands: RunnerCommands | null,
  runnerStatus: RunnerFacts['runnerStatus'] = 'online',
): RunnerFacts => ({ runnerStatus, runnerCommands });

const advert = (commands: string[], disabled: string[] = []) =>
  project({ commands, disabled });

describe('runnerSupport', () => {
  test('no advert, or no project yet, is unknown — never none', () => {
    expect(runnerSupport(project(null), 'planner')).toBe('unknown');
    expect(runnerSupport(undefined, 'planner')).toBe('unknown');
  });

  test('listed, disabled and missing', () => {
    expect(runnerSupport(advert(ALL), 'planner')).toBe('supported');
    expect(runnerSupport(advert(ALL, ['plan.turn']), 'planner')).toBe(
      'disabled',
    );
    expect(runnerSupport(advert(['worktree.status']), 'planner')).toBe(
      'missing',
    );
  });

  test('design needs every one of its commands', () => {
    expect(
      runnerSupport(advert(['plan.turn', 'uiprofile.build']), 'design'),
    ).toBe('missing');
    expect(runnerSupport(advert(ALL, ['uiprofile.build']), 'design')).toBe(
      'disabled',
    );
    expect(runnerSupport(advert(ALL), 'design')).toBe('supported');
  });
});

describe('runnerGate', () => {
  test('missing is outdated, disabled is disabled, the rest is no gate', () => {
    expect(runnerGate(advert(['worktree.status']), 'planner')).toBe('outdated');
    expect(runnerGate(advert(ALL, ['plan.turn']), 'planner')).toBe('disabled');
    expect(runnerGate(advert(ALL), 'planner')).toBeNull();
    expect(runnerGate(project(null), 'planner')).toBeNull();
    expect(runnerGate(undefined, 'planner')).toBeNull();
  });

  test('a runner that is not online has the offline banner instead', () => {
    for (const status of ['offline', 'stale'] as const) {
      expect(
        runnerGate(project({ commands: [], disabled: [] }, status), 'planner'),
      ).toBeNull();
    }
  });
});

describe('plannerRunnerBlock', () => {
  const refusal = 'plan.turn failed on the runner: unknown_command';

  test('plan.turn missing: the banner and Plan off, before any turn', () => {
    expect(
      plannerRunnerBlock({
        project: advert(['worktree.status']),
        createdTooOld: false,
        newestReason: undefined,
      }),
    ).toEqual({ gate: 'outdated', known: true });
  });

  test('plan.turn disabled in the runner config', () => {
    expect(
      plannerRunnerBlock({
        project: advert(ALL, ['plan.turn']),
        createdTooOld: false,
        newestReason: null,
      }),
    ).toEqual({ gate: 'disabled', known: true });
  });

  test('a known advert ignores the reactive signal, so the banner clears after an update', () => {
    expect(
      plannerRunnerBlock({
        project: advert(ALL),
        createdTooOld: true,
        newestReason: refusal,
      }),
    ).toBeNull();
  });

  test('an unknown advert keeps the reactive signal, and Plan stays on', () => {
    expect(
      plannerRunnerBlock({
        project: project(null),
        createdTooOld: false,
        newestReason: refusal,
      }),
    ).toEqual({ gate: 'outdated', known: false });
    expect(
      plannerRunnerBlock({
        project: project(null),
        createdTooOld: true,
        newestReason: null,
      }),
    ).toEqual({ gate: 'outdated', known: false });
    expect(
      plannerRunnerBlock({
        project: project(null),
        createdTooOld: false,
        newestReason: 'budget exceeded',
      }),
    ).toBeNull();
  });

  test('offline wins, and nothing shows while the project loads', () => {
    expect(
      plannerRunnerBlock({
        project: project({ commands: [], disabled: [] }, 'offline'),
        createdTooOld: true,
        newestReason: refusal,
      }),
    ).toBeNull();
    expect(
      plannerRunnerBlock({
        project: undefined,
        createdTooOld: true,
        newestReason: refusal,
      }),
    ).toBeNull();
  });
});

describe('runnerGateCopy', () => {
  test('outdated links the update; disabled names the config, no link', () => {
    const outdated = runnerGateCopy('planner', 'outdated');
    expect(outdated.body).toBe(RUNNER_TOO_OLD_TEXT);
    expect(outdated.href).toBe(RUNNER_UPDATE_HREF);
    expect(outdated.cta).toBe('Update the runner');

    const disabled = runnerGateCopy('worktree', 'disabled');
    expect(disabled.body).toContain('disabledCommands');
    expect(disabled.reason).toContain('disabledCommands');
    expect(disabled.href).toBeUndefined();
    expect(disabled.cta).toBeUndefined();
  });

  test('each feature names what it cannot do', () => {
    expect(runnerGateCopy('design', 'outdated').title).toBe(
      'The runner is too old to draw mockups',
    );
    expect(runnerGateCopy('uiProfileBuild', 'outdated').reason).toContain(
      'build the UI profile',
    );
    expect(runnerGateCopy('worktree', 'outdated').body).toContain(
      'read worktrees',
    );
  });
});

describe('failedTurnCopy', () => {
  test('unknown_command is "too old" with the update link', () => {
    expect(
      failedTurnCopy(
        turn({ phase: 'failed', error: 'plan.turn: unknown_command' }),
      ),
    ).toEqual({
      title: 'The runner is too old to plan',
      text: RUNNER_TOO_OLD_TEXT,
      updateHref: RUNNER_UPDATE_HREF,
    });
  });

  test('a contract violation says nothing was changed', () => {
    const copy = failedTurnCopy(
      turn({ phase: 'failed', error: 'contract_violation: tasks[0]' }),
    );
    expect(copy.title).toBe('The planner’s answer did not follow the contract');
    expect(copy.text).toBe('Nothing was changed. contract_violation: tasks[0]');
    expect(copy.updateHref).toBeNull();
  });

  test('any other failure shows its error, or that there was none', () => {
    expect(failedTurnCopy(turn({ phase: 'failed', error: 'boom' }))).toEqual({
      title: 'The turn failed',
      text: 'boom',
      updateHref: null,
    });
    expect(failedTurnCopy(turn({ phase: 'failed', error: null })).text).toBe(
      'The runner gave no reason.',
    );
  });
});
