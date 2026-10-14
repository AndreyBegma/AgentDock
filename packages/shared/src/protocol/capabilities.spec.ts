import { describe, expect, it } from 'bun:test';
import {
  type CommandName,
  commandNames,
  commandSupport,
  commandsSupport,
  RUNNER_FEATURE_COMMANDS,
  type RunnerCommands,
  runnerCommandsOf,
} from './index';

const advert = (
  commands: string[],
  disabled: string[] = [],
): RunnerCommands => ({ commands, disabled });

describe('runnerCommandsOf', () => {
  it('is null when commands is absent — unknown, never none', () => {
    expect(runnerCommandsOf({ tmux: '3.5a', terminal: true })).toBeNull();
    expect(runnerCommandsOf({ disabledCommands: ['plan.turn'] })).toBeNull();
  });

  it('is null for JSON that is not a capabilities object', () => {
    for (const value of [null, undefined, 'plan.turn', 7, []]) {
      expect(runnerCommandsOf(value)).toBeNull();
    }
    expect(runnerCommandsOf({ commands: 'plan.turn' })).toBeNull();
    expect(runnerCommandsOf({ commands: [''] })).toBeNull();
  });

  it('reads commands and defaults disabled to none', () => {
    expect(runnerCommandsOf({ commands: ['plan.turn'] })).toEqual(
      advert(['plan.turn']),
    );
  });

  it('keeps only disabled names the runner serves', () => {
    expect(
      runnerCommandsOf({
        commands: ['plan.turn', 'worktree.status'],
        disabledCommands: ['worktree.status', 'pr.approve'],
      }),
    ).toEqual(advert(['plan.turn', 'worktree.status'], ['worktree.status']));
  });

  it('reads the commands even when other stored fields no longer validate', () => {
    expect(
      runnerCommandsOf({
        tmux: 42,
        profiles: 'broken',
        commands: ['plan.turn'],
      }),
    ).toEqual(advert(['plan.turn']));
  });

  it('drops duplicate names', () => {
    expect(
      runnerCommandsOf({
        commands: ['plan.turn', 'plan.turn'],
        disabledCommands: ['plan.turn', 'plan.turn'],
      }),
    ).toEqual(advert(['plan.turn'], ['plan.turn']));
  });

  it('only ever leaves command names in the result', () => {
    const result = runnerCommandsOf({
      tmux: '3.5a',
      codeSentinel: { version: '1.0.0', path: '/home/someone/plugin' },
      commands: ['plan.turn'],
    });
    expect(Object.keys(result ?? {}).sort()).toEqual(['commands', 'disabled']);
  });
});

describe('commandSupport', () => {
  it('is unknown without an advert', () => {
    expect(commandSupport(null, 'plan.turn')).toBe('unknown');
    expect(commandSupport(undefined, 'plan.turn')).toBe('unknown');
  });

  it('is supported when listed and enabled', () => {
    expect(commandSupport(advert(['plan.turn']), 'plan.turn')).toBe(
      'supported',
    );
  });

  it('is disabled when listed and switched off', () => {
    expect(
      commandSupport(advert(['plan.turn'], ['plan.turn']), 'plan.turn'),
    ).toBe('disabled');
  });

  it('is missing when not listed', () => {
    expect(commandSupport(advert(['worktree.status']), 'plan.turn')).toBe(
      'missing',
    );
    expect(commandSupport(advert([]), 'plan.turn')).toBe('missing');
  });
});

describe('commandsSupport', () => {
  const design: readonly CommandName[] = RUNNER_FEATURE_COMMANDS.design;

  it('is unknown without an advert', () => {
    expect(commandsSupport(null, design)).toBe('unknown');
  });

  it('is supported when every command is', () => {
    expect(commandsSupport(advert([...design]), design)).toBe('supported');
  });

  it('is supported for an empty set', () => {
    expect(commandsSupport(advert([]), [])).toBe('supported');
  });

  it('ranks missing over disabled', () => {
    expect(
      commandsSupport(
        advert(['plan.turn', 'uiprofile.fingerprint'], ['plan.turn']),
        design,
      ),
    ).toBe('missing');
  });

  it('ranks disabled over supported', () => {
    expect(
      commandsSupport(advert([...design], ['uiprofile.build']), design),
    ).toBe('disabled');
  });
});

describe('RUNNER_FEATURE_COMMANDS', () => {
  it('names only commands in the allowlist', () => {
    for (const names of Object.values(RUNNER_FEATURE_COMMANDS)) {
      for (const name of names) expect(commandNames).toContain(name);
    }
  });
});
