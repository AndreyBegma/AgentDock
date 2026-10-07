import { describe, expect, it } from 'bun:test';
import {
  type CommandResultMessage,
  commandResultMessageSchema,
  DEFAULT_COMMAND_TIMEOUT_MS,
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
