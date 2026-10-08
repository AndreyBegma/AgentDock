import { describe, expect, it } from 'bun:test';
import type { BackfillScope } from '../adapters';
import { FakeClock } from '../testing/fake-clock';
import { fakeExec, memoryLogger } from '../testing/fixtures';
import { createDispatcher } from './dispatcher';
import { createHandlers } from './handlers';

const ACME = { id: 'prj_acme', root: '/srv/dev/acme' };
const SINCE = '2026-09-01T00:00:00.000Z';

const setup = (
  backfill?: (
    scope: BackfillScope,
  ) => Promise<{ files: number; events: number }>,
) => {
  const clock = new FakeClock();
  const { log } = memoryLogger();
  return createDispatcher({
    handlers: createHandlers({
      clock,
      runnerVersion: '0.0.0-test',
      host: { hostname: 'h', os: 'linux', arch: 'x64' },
      detectCapabilities: () => Promise.reject(new Error('unused')),
      exec: fakeExec({}),
      watchedProjects: () => [ACME],
      backfillSessions: backfill,
    }),
    disabledCommands: [],
    clock,
    log,
  });
};

const send = (dispatch: ReturnType<typeof setup>, args: unknown) =>
  dispatch({ type: 'command', id: 'cmd_1', name: 'session.backfill', args });

describe('session.backfill', () => {
  it('passes the scope to the session watcher and answers with its counts', async () => {
    const scopes: BackfillScope[] = [];
    const dispatch = setup(async (scope) => {
      scopes.push(scope);
      return { files: 3, events: 120 };
    });
    expect(
      await send(dispatch, { since: SINCE, projectId: 'prj_acme' }),
    ).toEqual({
      type: 'command.result',
      id: 'cmd_1',
      ok: true,
      output: { files: 3, events: 120 },
    });
    expect(await send(dispatch, { since: SINCE })).toMatchObject({ ok: true });
    expect(scopes).toEqual([
      { projectId: 'prj_acme', since: new Date(SINCE) },
      { since: new Date(SINCE) },
    ]);
  });

  it('refuses a project that is not on the watch list', async () => {
    const dispatch = setup(async () => ({ files: 0, events: 0 }));
    expect(
      await send(dispatch, { since: SINCE, projectId: 'prj_other' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'path_not_allowed' },
    });
  });

  it('answers disabled when sessions are off on this runner', async () => {
    expect(await send(setup(), { since: SINCE })).toMatchObject({
      ok: false,
      error: { code: 'disabled' },
    });
  });
});
