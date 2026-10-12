import { describe, expect, it } from 'bun:test';
import {
  type CommandResultMessage,
  commandResultMessageSchema,
  commands,
  DEFAULT_COMMAND_TIMEOUT_MS,
  SKILL_TIMEOUTS_MS,
  TERMINAL_ATTACH_TIMEOUT_MS,
} from '@agentdock/shared/protocol';
import { FakeClock } from '../testing/fake-clock';
import { fakeExec, memoryLogger } from '../testing/fixtures';
import { type CommandHandlers, createDispatcher } from './dispatcher';
import { CommandFailure } from './failure';
import { createHandlers } from './handlers';

const host = { hostname: 'test-host', os: 'linux', arch: 'x64' };

const setup = (
  overrides: Partial<CommandHandlers> = {},
  disabledCommands: string[] = [],
) => {
  const clock = new FakeClock();
  const { log, lines } = memoryLogger();
  const handlers: CommandHandlers = {
    ...createHandlers({
      clock,
      runnerVersion: '0.1.0',
      host,
      detectCapabilities: async () => ({
        tmux: null,
        git: null,
        gh: null,
        runtimes: { claude: null, codex: null },
        profiles: [],
        codeSentinel: null,
        otlp: null,
      }),
      exec: fakeExec({}),
      watchedProjects: () => [{ id: 'prj_a', root: '/nowhere/a' }],
      profiles: () => [],
    }),
    ...overrides,
  };
  const dispatch = createDispatcher({ handlers, disabledCommands, clock, log });
  const run = async (name: string, args: unknown = {}) => {
    const result: CommandResultMessage = await dispatch({
      type: 'command',
      id: 'c1',
      name,
      args,
    });
    // Every answer is a valid wire message.
    commandResultMessageSchema.parse(result);
    return result;
  };
  return { clock, dispatch, run, lines };
};

describe('command dispatcher', () => {
  it('runner.ping returns ok with pong and the clock time', async () => {
    const { run } = setup();
    expect(await run('runner.ping')).toEqual({
      type: 'command.result',
      id: 'c1',
      ok: true,
      output: { pong: true, ts: '2026-10-07T18:00:00.000Z' },
    });
  });

  it('runner.describe returns host, version and capabilities', async () => {
    const { run } = setup();
    const result = await run('runner.describe');
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({ ...host, runnerVersion: '0.1.0' });
  });

  it('answers unknown_command for a name outside the allowlist', async () => {
    const { run } = setup();
    expect((await run('shell.exec', { cmd: 'rm -rf /' })).error).toEqual({
      code: 'unknown_command',
      message: 'unknown command: shell.exec',
    });
  });

  it('does not treat inherited object keys as commands', async () => {
    const { run } = setup();
    expect((await run('constructor')).error?.code).toBe('unknown_command');
    expect((await run('__proto__')).error?.code).toBe('unknown_command');
  });

  it('answers disabled for a command in disabledCommands', async () => {
    const { run } = setup({}, ['runner.ping']);
    expect((await run('runner.ping')).error?.code).toBe('disabled');
  });

  it('answers invalid_args when args fail the schema', async () => {
    const { run } = setup();
    expect((await run('runner.ping', { extra: 1 })).error?.code).toBe(
      'invalid_args',
    );
    expect((await run('runner.ping', null)).error?.code).toBe('invalid_args');
  });

  it('answers internal without a stack trace when a handler throws', async () => {
    const { run } = setup({
      'runner.ping': () => {
        throw new Error('disk on fire\n    at handler (/secret/path.ts:1:1)');
      },
    });
    const result = await run('runner.ping');
    expect(result.error).toEqual({ code: 'internal', message: 'disk on fire' });
  });

  it('answers internal when a handler returns something off-schema', async () => {
    const { run } = setup({
      // @ts-expect-error — deliberately wrong result
      'runner.ping': () => ({ pong: false }),
    });
    expect((await run('runner.ping')).error?.code).toBe('internal');
  });

  it('answers timeout when a handler outlives its timeout', async () => {
    const { clock, dispatch } = setup({
      'runner.ping': () => new Promise(() => {}),
    });
    const pending = dispatch({
      type: 'command',
      id: 'c9',
      name: 'runner.ping',
      args: {},
    });
    await Bun.sleep(0);
    clock.advance(DEFAULT_COMMAND_TIMEOUT_MS);
    expect((await pending).error?.code).toBe('timeout');
  });

  it('answers the code of a CommandFailure instead of internal', async () => {
    const { run } = setup({
      'runner.ping': () => {
        throw new CommandFailure('path_not_allowed', 'nope');
      },
    });
    expect((await run('runner.ping')).error).toEqual({
      code: 'path_not_allowed',
      message: 'nope',
    });
  });

  describe('terminal.attach (spec 29)', () => {
    const attachArgs = {
      id: 'term_1',
      target: {
        kind: 'slot',
        projectId: 'prj_a',
        root: '/nowhere/a',
        slot: 'i42',
      },
      mode: 'read',
      cols: 120,
      rows: 40,
    };

    it('is in the allowlist, admin only, under a 10 s timeout', () => {
      expect(commands['terminal.attach'].minRole).toBe('admin');
      expect(commands['terminal.attach'].timeoutMs).toBe(
        TERMINAL_ATTACH_TIMEOUT_MS,
      );
    });

    it('refuses a raw session name or a command anywhere in the args', async () => {
      const { run } = setup();
      for (const args of [
        { ...attachArgs, session: 'cs-i42' },
        { ...attachArgs, command: 'sh' },
        { ...attachArgs, target: { ...attachArgs.target, session: 'cs-i42' } },
        { ...attachArgs, target: { kind: 'session', name: 'cs-i42' } },
        {
          ...attachArgs,
          target: {
            kind: 'orchestrator',
            projectId: 'prj_a',
            root: '/nowhere/a',
            command: 'sh',
          },
        },
      ]) {
        expect((await run('terminal.attach', args)).error?.code).toBe(
          'invalid_args',
        );
      }
    });

    it('answers disabled when the runner config lists it', async () => {
      const { run } = setup({}, ['terminal.attach']);
      expect((await run('terminal.attach', attachArgs)).error?.code).toBe(
        'disabled',
      );
    });

    it('answers unsupported on a runner without an attach manager', async () => {
      const { run } = setup();
      expect((await run('terminal.attach', attachArgs)).error?.code).toBe(
        'unsupported',
      );
    });
  });

  describe('skill.* (spec 24)', () => {
    it('is in the allowlist with D14 roles and its own timeouts', () => {
      expect(commands['skill.search'].minRole).toBe('operator');
      expect(commands['skill.inspect'].minRole).toBe('operator');
      expect(commands['skill.install'].minRole).toBe('operator');
      expect(commands['skill.uninstall'].minRole).toBe('admin');
      expect(commands['skill.list'].minRole).toBe('viewer');
      expect(commands['skill.run'].minRole).toBe('operator');
      expect(commands['skill.cancel'].minRole).toBe('operator');
      expect(commands['skill.inspect'].timeoutMs).toBe(
        SKILL_TIMEOUTS_MS.inspect,
      );
    });

    it('refuses a host or URL argument as invalid_args', async () => {
      const { run } = setup();
      for (const args of [
        { query: 'estimate', host: 'evil.example' },
        { query: 'estimate', url: 'https://evil.example/api/search' },
      ]) {
        expect((await run('skill.search', args)).error?.code).toBe(
          'invalid_args',
        );
      }
      for (const source of [
        'acme/../x',
        'https://github.com/acme/x',
        'gitlab.com/a/b',
      ]) {
        expect((await run('skill.inspect', { source })).error?.code).toBe(
          'invalid_args',
        );
      }
    });

    it('answers unsupported on a runner without skills', async () => {
      const { run } = setup();
      expect(
        (await run('skill.search', { query: 'estimate' })).error?.code,
      ).toBe('unsupported');
      expect(
        (await run('skill.cancel', { runId: 'run_1', projectId: 'prj_a' }))
          .error?.code,
      ).toBe('unsupported');
    });
  });

  it('refuses project.inspect with a relative path as invalid_args', async () => {
    const { run } = setup();
    expect(
      (await run('project.inspect', { path: 'dev/AgentDock' })).error?.code,
    ).toBe('invalid_args');
  });

  it('answers path_not_found for project.inspect of a missing directory', async () => {
    const { run } = setup();
    expect(
      (await run('project.inspect', { path: '/nowhere/at/all' })).error?.code,
    ).toBe('path_not_found');
  });

  it('refuses project.refresh of a root not registered under that project', async () => {
    const { run } = setup();
    for (const args of [
      { projectId: 'prj_a', root: '/etc' },
      { projectId: 'prj_b', root: '/nowhere/a' },
    ]) {
      expect((await run('project.refresh', args)).error?.code).toBe(
        'path_not_allowed',
      );
    }
  });
});
