import type { BackfillResponse, SessionErrorBody } from '@agentdock/shared';
import type { CommandErrorCode } from '@agentdock/shared/protocol';
import { Logger } from '@nestjs/common';
import {
  adminSession,
  CapturingLogger,
  createRunnerE2eApp,
  pairedRunner,
  type RunnerE2eContext,
  TestRunnerSocket,
} from '../runners/testing/runner-e2e';
import {
  createUser,
  login,
  resetDatabase,
  type Session,
} from '../test/e2e-app';

type Answer =
  | { ok: true; output: BackfillResponse }
  | { ok: false; code: CommandErrorCode; message: string };

interface Received {
  name: string;
  args: unknown;
}

/** A connected runner that answers every command with `answer`. */
const serve = (socket: TestRunnerSocket, answer: () => Answer) => {
  const received: Received[] = [];
  void (async () => {
    for (;;) {
      let command: Awaited<ReturnType<TestRunnerSocket['next']>>;
      try {
        command = await socket.next('command', 60_000);
      } catch {
        return;
      }
      received.push({ name: command.name, args: command.args });
      const reply = answer();
      socket.send(
        reply.ok
          ? {
              type: 'command.result',
              id: command.id,
              ok: true,
              output: reply.output,
            }
          : {
              type: 'command.result',
              id: command.id,
              ok: false,
              error: { code: reply.code, message: reply.message },
            },
      );
    }
  })();
  return received;
};

describe('POST /admin/runners/:id/backfill (e2e)', () => {
  let ctx: RunnerE2eContext;
  let admin: Session;
  const sockets: TestRunnerSocket[] = [];

  const connected = async (answer: () => Answer) => {
    const { runnerId, token } = await pairedRunner(ctx, admin);
    const socket = new TestRunnerSocket(ctx.origin, token);
    sockets.push(socket);
    await socket.connect();
    return { runnerId, received: serve(socket, answer) };
  };

  const project = (runnerId: string) =>
    ctx.prisma.project.create({
      data: {
        runnerId,
        rootPath: '/srv/dev/acme',
        repo: 'acme/acme',
        displayName: 'acme',
        baseBranch: 'develop',
        baseSource: 'config',
        hasClaudeMd: true,
        hasAgentsMd: false,
        lastInspectedAt: new Date(),
      },
    });

  const backfill = (caller: Session, runnerId: string, body: object) =>
    caller.send('post', `/admin/runners/${runnerId}/backfill`, body);

  beforeAll(async () => {
    ctx = await createRunnerE2eApp({}, new CapturingLogger());
  });
  afterAll(() => ctx.app.close());
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    admin = await adminSession(ctx);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const socket of sockets.splice(0)) socket.socket.terminate();
  });

  it('sends session.backfill in UTC and answers with the runner counts', async () => {
    const { runnerId, received } = await connected(() => ({
      ok: true,
      output: { files: 2, events: 40 },
    }));
    const { id: projectId } = await project(runnerId);

    const response = await backfill(admin, runnerId, {
      projectId,
      since: '2026-10-01T02:00:00+02:00',
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ files: 2, events: 40 });
    expect(received).toEqual([
      {
        name: 'session.backfill',
        args: { projectId, since: '2026-10-01T00:00:00.000Z' },
      },
    ]);

    const all = await backfill(admin, runnerId, {
      since: '2026-10-01T00:00:00Z',
    });
    expect(all.status).toBe(200);
    expect(received[1].args).toEqual({ since: '2026-10-01T00:00:00.000Z' });
  });

  it('is admin only: anonymous gets 401, a viewer 403', async () => {
    const { runnerId, received } = await connected(() => ({
      ok: true,
      output: { files: 0, events: 0 },
    }));
    const body = { since: '2026-10-01T00:00:00Z' };
    expect(
      (await ctx.http().post(`/admin/runners/${runnerId}/backfill`).send(body))
        .status,
    ).toBe(401);
    await createUser(ctx.prisma, 'viewer@example.test', 'viewer');
    const viewer = await login(ctx, 'viewer@example.test');
    expect((await backfill(viewer, runnerId, body)).status).toBe(403);
    expect(received).toEqual([]);
  });

  it('refuses a bad since, an unknown runner, and a project of another runner', async () => {
    const { runnerId, received } = await connected(() => ({
      ok: true,
      output: { files: 0, events: 0 },
    }));
    expect((await backfill(admin, runnerId, {})).status).toBe(400);
    expect(
      (await backfill(admin, runnerId, { since: 'last week' })).status,
    ).toBe(400);
    expect(
      (
        await backfill(admin, runnerId, {
          since: '2026-10-01T00:00:00Z',
          extra: 1,
        })
      ).status,
    ).toBe(400);

    const unknown = await backfill(admin, 'nope', {
      since: '2026-10-01T00:00:00Z',
    });
    expect(unknown.status).toBe(404);

    const other = await pairedRunner(ctx, admin);
    const { id: foreign } = await project(other.runnerId);
    const response = await backfill(admin, runnerId, {
      projectId: foreign,
      since: '2026-10-01T00:00:00Z',
    });
    expect(response.status).toBe(404);
    expect((response.body as SessionErrorBody).error).toBe('not_found');
    expect(received).toEqual([]);
  });

  it('answers 409 runner_offline for a runner without a connection', async () => {
    const { runnerId } = await pairedRunner(ctx, admin);
    const response = await backfill(admin, runnerId, {
      since: '2026-10-01T00:00:00Z',
    });
    expect(response.status).toBe(409);
    expect((response.body as SessionErrorBody).error).toBe('runner_offline');
  });

  it('maps a refusal to 409 runner_refused and a failure to 502 runner_error', async () => {
    let answer: Answer = {
      ok: false,
      code: 'disabled',
      message: 'sessions are disabled on this runner',
    };
    const { runnerId } = await connected(() => answer);
    const body = { since: '2026-10-01T00:00:00Z' };

    const refused = await backfill(admin, runnerId, body);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      error: 'runner_refused',
      message: 'disabled: sessions are disabled on this runner',
    });

    answer = { ok: false, code: 'internal', message: 'disk on fire' };
    const failed = await backfill(admin, runnerId, body);
    expect(failed.status).toBe(502);
    expect((failed.body as SessionErrorBody).error).toBe('runner_error');
  });
});
