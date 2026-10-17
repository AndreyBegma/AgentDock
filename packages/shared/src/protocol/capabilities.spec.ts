import { describe, expect, it } from 'bun:test';
import {
  type CommandName,
  commandNames,
  commandSupport,
  commandsSupport,
  PROFILE_ARGS_MAX,
  PROFILE_ENV_MAX,
  PROFILE_STRING_MAX,
  RUNNER_FEATURE_COMMANDS,
  type RunnerCommands,
  reportProfileEnv,
  runnerCommandsOf,
  runtimeProfileSchema,
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

describe('runtimeProfileSchema (C-123)', () => {
  const profile = {
    id: 'claude-work',
    runtime: 'claude',
    env: {},
    args: [],
    authenticated: true,
  };
  const valid = (overrides: Record<string, unknown>) =>
    runtimeProfileSchema.safeParse({ ...profile, ...overrides }).success;

  it('accepts a set name and a value for an allowlisted path', () => {
    expect(
      valid({
        env: {
          ANTHROPIC_API_KEY: { set: true },
          CLAUDE_CONFIG_DIR: '/home/dev/.claude-profiles/work',
          CODEX_HOME: '/home/dev/.codex',
        },
      }),
    ).toBe(true);
  });

  it('rejects an env value for any name outside the allowlist', () => {
    expect(valid({ env: { ANTHROPIC_API_KEY: 'sk-ant-x' } })).toBe(false);
    expect(valid({ env: { PATH: '/usr/bin' } })).toBe(false);
    expect(valid({ env: { ANTHROPIC_API_KEY: { set: false } } })).toBe(false);
    expect(
      valid({ env: { ANTHROPIC_API_KEY: { set: true, value: 'sk-ant-x' } } }),
    ).toBe(false);
  });

  it('rejects an oversize env, args or binary', () => {
    const env = Object.fromEntries(
      Array.from({ length: PROFILE_ENV_MAX + 1 }, (_, i) => [
        `V${i}`,
        { set: true },
      ]),
    );
    expect(valid({ env })).toBe(false);
    expect(valid({ args: Array(PROFILE_ARGS_MAX).fill('-v') })).toBe(true);
    expect(valid({ args: Array(PROFILE_ARGS_MAX + 1).fill('-v') })).toBe(false);
    const long = 'x'.repeat(PROFILE_STRING_MAX + 1);
    expect(valid({ args: [long] })).toBe(false);
    expect(valid({ binary: long })).toBe(false);
    expect(valid({ binary: 'x'.repeat(PROFILE_STRING_MAX) })).toBe(true);
    expect(valid({ env: { CLAUDE_CONFIG_DIR: long } })).toBe(false);
  });

  it('reportProfileEnv keeps allowlisted paths and marks the rest set', () => {
    const reported = reportProfileEnv({
      ANTHROPIC_API_KEY: 'sk-ant-x',
      CLAUDE_CONFIG_DIR: '/p',
    });
    expect(reported).toEqual({
      ANTHROPIC_API_KEY: { set: true },
      CLAUDE_CONFIG_DIR: '/p',
    });
    expect(valid({ env: reported })).toBe(true);
  });
});
