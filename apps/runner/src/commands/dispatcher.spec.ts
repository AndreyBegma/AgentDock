import { describe, expect, it } from 'bun:test';
import {
  type CommandResultMessage,
  commandResultMessageSchema,
  commands,
  DEFAULT_COMMAND_TIMEOUT_MS,
  PLAN_TIMEOUTS_MS,
  SKILL_TIMEOUTS_MS,
  TERMINAL_ATTACH_TIMEOUT_MS,
} from '@nautelle/shared/protocol';
import { permissivePolicy, sameRealpath } from '../policy/testing';
import { FakeClock } from '../testing/fake-clock';
import { fakeExec, memoryLogger } from '../testing/fixtures';
import { DEDUP_TTL_MS } from './dedup';
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
      policy: permissivePolicy,
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
  const dispatch = createDispatcher({
    handlers,
    disabledCommands,
    policy: permissivePolicy,
    realpath: sameRealpath,
    clock,
    log,
  });
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

  describe('a timeout aborts the handler (#740 D5)', () => {
    it('aborts the signal and kills a child the handler spawned', async () => {
      let seen: AbortSignal | undefined;
      let child: ReturnType<typeof Bun.spawn> | undefined;
      const { clock, dispatch } = setup({
        'runner.ping': async (_args, signal) => {
          seen = signal;
          child = Bun.spawn(['sleep', '30'], { signal });
          await child.exited;
          return { pong: true, ts: 'never' };
        },
      });
      const pending = dispatch({
        type: 'command',
        id: 'c_abort',
        name: 'runner.ping',
        args: {},
      });
      await Bun.sleep(0);
      expect(seen?.aborted).toBe(false);
      clock.advance(DEFAULT_COMMAND_TIMEOUT_MS);

      expect((await pending).error?.code).toBe('timeout');
      expect(seen?.aborted).toBe(true);
      await child?.exited;
      expect(child?.killed).toBe(true);
    });

    it('forgets a timed-out id, so a retry runs fresh', async () => {
      let calls = 0;
      const { clock, dispatch } = setup({
        'runner.ping': () => {
          calls += 1;
          return calls === 1
            ? new Promise(() => {})
            : { pong: true, ts: '2026-10-07T18:00:00.000Z' };
        },
      });
      const message = {
        type: 'command',
        id: 'c_retry',
        name: 'runner.ping',
        args: {},
      } as const;
      const first = dispatch(message);
      await Bun.sleep(0);
      clock.advance(DEFAULT_COMMAND_TIMEOUT_MS);
      expect((await first).error?.code).toBe('timeout');
      await Bun.sleep(0);

      expect((await dispatch(message)).ok).toBe(true);
      expect(calls).toBe(2);
    });
  });

  describe('a repeated command id (#740 D3)', () => {
    const ping = (id: string) =>
      ({ type: 'command', id, name: 'runner.ping', args: {} }) as const;

    it('runs the handler once; both dispatches get the same result', async () => {
      let calls = 0;
      const { dispatch } = setup({
        'runner.ping': async () => {
          calls += 1;
          await Bun.sleep(1);
          return { pong: true, ts: `2026-10-07T18:00:0${calls}.000Z` };
        },
      });
      const [first, second] = await Promise.all([
        dispatch(ping('c_dup')),
        dispatch(ping('c_dup')),
      ]);
      const third = await dispatch(ping('c_dup'));

      expect(calls).toBe(1);
      expect(second).toEqual(first);
      expect(third).toEqual(first);
    });

    it('runs it again once the 1 h TTL has passed', async () => {
      let calls = 0;
      const { clock, dispatch } = setup({
        'runner.ping': () => {
          calls += 1;
          return { pong: true, ts: '2026-10-07T18:00:00.000Z' };
        },
      });
      await dispatch(ping('c_ttl'));
      clock.advance(DEDUP_TTL_MS - 1);
      await dispatch(ping('c_ttl'));
      expect(calls).toBe(1);

      clock.advance(1);
      await dispatch(ping('c_ttl'));
      expect(calls).toBe(2);
    });

    it('runs a known id with other content as new, with a warning', async () => {
      let calls = 0;
      const { dispatch, lines } = setup({
        'runner.ping': () => {
          calls += 1;
          return { pong: true, ts: '2026-10-07T18:00:00.000Z' };
        },
      });
      await dispatch(ping('c_same'));
      const other = await dispatch({
        type: 'command',
        id: 'c_same',
        name: 'runner.unknown',
        args: {},
      });

      expect(calls).toBe(1);
      expect(other.error?.code).toBe('unknown_command');
      expect(lines.join('\n')).toContain('a known id with other content');
    });
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

  describe('plan.* (spec 172)', () => {
    const turnArgs = {
      planId: 'plan_1',
      turnId: 'turn_1',
      runId: 'run_1',
      projectId: 'prj_a',
      root: '/nowhere/a',
      base: 'main',
      session: { id: '11111111-1111-4111-8111-111111111111', resume: false },
      prompt: 'Decompose.',
      profileKey: 'claude-work',
      model: 'opus',
      timeoutSec: 1200,
    };

    it('is in the allowlist, operator-only, with its own timeouts', () => {
      for (const name of [
        'plan.turn',
        'plan.cancel',
        'plan.close',
        'plan.publish_specs',
        'plan.queue_issues',
      ] as const) {
        expect(commands[name].minRole).toBe('operator');
      }
      expect(commands['plan.turn'].timeoutMs).toBe(PLAN_TIMEOUTS_MS.turn);
      expect(commands['plan.publish_specs'].timeoutMs).toBe(
        PLAN_TIMEOUTS_MS.publishSpecs,
      );
    });

    it('refuses a prompt in place of data, a shell field and a path escape as invalid_args', async () => {
      const { run } = setup();
      for (const args of [
        { ...turnArgs, prompt: '' },
        { ...turnArgs, command: 'claude -p "$(rm -rf ~)"' },
        { ...turnArgs, session: { id: 'not-a-uuid', resume: false } },
      ]) {
        expect((await run('plan.turn', args)).error?.code).toBe('invalid_args');
      }
      expect(
        (
          await run('plan.publish_specs', {
            planId: 'plan_1',
            projectId: 'prj_a',
            root: '/nowhere/a',
            base: 'main',
            specDir: 'docs/specs',
            branch: 'docs/plan-abc12345',
            files: [{ path: 'docs/specs/../../etc/x.md', content: 'x' }],
            title: 'docs',
            body: '',
          })
        ).error?.code,
      ).toBe('invalid_args');
    });

    it('routes each command to the planner handlers', async () => {
      const seen: string[] = [];
      const { run } = setup({
        'plan.turn': async () => {
          seen.push('turn');
          return { phase: 'queued' };
        },
        'plan.cancel': async () => {
          seen.push('cancel');
          return { cancelled: true };
        },
      });
      expect((await run('plan.turn', turnArgs)).output).toEqual({
        phase: 'queued',
      });
      expect(
        (
          await run('plan.cancel', {
            planId: 'plan_1',
            turnId: 'turn_1',
            projectId: 'prj_1',
          })
        ).output,
      ).toEqual({ cancelled: true });
      expect(seen).toEqual(['turn', 'cancel']);
    });

    it('answers unsupported on a runner without a planner', async () => {
      const { run } = setup();
      expect((await run('plan.turn', turnArgs)).error?.code).toBe(
        'unsupported',
      );
      expect(
        (await run('plan.close', { planId: 'plan_1', projectId: 'prj_a' }))
          .error?.code,
      ).toBe('unsupported');
      expect(
        (await run('plan.queue_issues', { projectId: 'prj_a', numbers: [1] }))
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
