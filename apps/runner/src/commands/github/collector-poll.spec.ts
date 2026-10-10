import { describe, expect, it } from 'bun:test';
import { commandResultMessageSchema } from '@agentdock/shared/protocol';
import { CollectorRegistry } from '../../collectors';
import { FakeClock } from '../../testing/fake-clock';
import { fakeExec, memoryLogger } from '../../testing/fixtures';
import { createDispatcher } from '../dispatcher';
import { CommandFailure } from '../failure';
import { createHandlers } from '../handlers';
import { collectorPoll } from './collector-poll';

const PROJECT = { id: 'prj_a', root: '/dev/a' };

describe('collector.poll', () => {
  it('polls the named collectors of a watched project', async () => {
    const asked: [string, readonly string[]][] = [];
    const result = await collectorPoll(
      { projectId: 'prj_a', collectors: ['issues', 'prs'] },
      {
        watchedProjects: () => [PROJECT],
        pollNow: async (projectId, targets) => {
          asked.push([projectId, targets]);
          return ['issues'];
        },
      },
    );
    expect(result).toEqual({ restarted: ['issues'] });
    expect(asked).toEqual([['prj_a', ['issues', 'prs']]]);
  });

  it('refuses a project this runner does not watch, polling nothing', async () => {
    let polled = false;
    const run = collectorPoll(
      { projectId: 'prj_other', collectors: ['issues'] },
      {
        watchedProjects: () => [PROJECT],
        pollNow: async () => {
          polled = true;
          return [];
        },
      },
    );
    await expect(run).rejects.toBeInstanceOf(CommandFailure);
    expect(polled).toBe(false);
  });

  it('goes through the dispatcher: args are validated, only the named fake collector is polled', async () => {
    const polled: string[] = [];
    const fake = (name: string) => () => ({
      name,
      start: () => {},
      stop: () => {},
      pollNow: async (targets: readonly string[]) => {
        const mine = targets.filter((target) => target === name);
        polled.push(...mine);
        return mine;
      },
    });
    const clock = new FakeClock();
    const { log } = memoryLogger();
    const registry = new CollectorRegistry({
      factories: [fake('issues'), fake('worktrees')],
      emit: () => {},
      log,
    });
    await registry.setProjects([PROJECT]);
    const dispatch = createDispatcher({
      handlers: createHandlers({
        clock,
        runnerVersion: '0.1.0',
        host: { hostname: 'test-host', os: 'linux', arch: 'x64' },
        detectCapabilities: async () => {
          throw new Error('not used');
        },
        exec: fakeExec({}),
        watchedProjects: () => [PROJECT],
        pollCollectors: (id, targets) => registry.pollNow(id, targets),
        profiles: () => [],
      }),
      disabledCommands: [],
      clock,
      log,
    });
    const run = async (args: unknown) =>
      commandResultMessageSchema.parse(
        await dispatch({
          type: 'command',
          id: 'c1',
          name: 'collector.poll',
          args,
        }),
      );

    expect(
      await run({ projectId: 'prj_a', collectors: ['issues', 'prs'] }),
    ).toMatchObject({ ok: true, output: { restarted: ['issues'] } });
    expect(polled).toEqual(['issues']);

    expect(
      await run({ projectId: 'prj_a', collectors: ['fleet'] }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_args' } });
    expect(
      await run({ projectId: 'prj_x', collectors: ['issues'] }),
    ).toMatchObject({ ok: false, error: { code: 'path_not_allowed' } });
    expect(polled).toEqual(['issues']);
  });
});
