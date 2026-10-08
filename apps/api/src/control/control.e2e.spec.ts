import {
  COMMAND_RUN_LIVE_EVENT,
  type CommandRunPage,
  type CommandRunView,
  type ControlErrorBody,
  type OrchestratorSettingsView,
  SLOT_MESSAGE_SENT_LIVE_EVENT,
} from '@agentdock/shared';
import type { CommandErrorCode } from '@agentdock/shared/protocol';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../app.module';
import { configureApp } from '../configure-app';
import { PrismaService } from '../database/prisma.service';
import { seedProject } from '../fleet/testing/fleet-e2e';
import { allowedLiveOrigin } from '../live/live-options';
import { TestLiveSocket } from '../live/testing/live-e2e';
import {
  adminSession,
  capabilities,
  eventually,
  hello,
  pairedRunner,
  TestRunnerSocket,
} from '../runners/testing/runner-e2e';
import {
  createUser,
  type E2eContext,
  login,
  resetDatabase,
  type Session,
} from '../test/e2e-app';
import { CONTROL_OPTIONS, type ControlOptions } from './control-options';

const ROOT_A = '/srv/dev/widget';
const ROOT_B = '/srv/dev/gadget';
const SESSION = 'agentdock-orch-acme-widget';
const STARTED_AT = '2026-10-08T10:00:00.000Z';
const SECRET_TEXT = 'Rebase onto develop — the passphrase is tangerine-42';

/** Short enough that the "never answers" case does not slow the suite. */
const TIMEOUT_MS = 400;
const options: ControlOptions = {
  timeoutsMs: {
    'orchestrator.start': TIMEOUT_MS,
    'orchestrator.stop': TIMEOUT_MS,
    'orchestrator.status': TIMEOUT_MS,
    'slot.stop': TIMEOUT_MS,
    'slot.message': TIMEOUT_MS,
  },
};

type Answer =
  | { ok: true; output: unknown }
  | { ok: false; code: CommandErrorCode; message?: string }
  | 'silence';

interface Received {
  name: string;
  args: Record<string, unknown>;
}

/** Slots each project's worktrees hold, as the runner's ownership check sees them. */
const SLOTS: Record<string, string[]> = {
  [ROOT_A]: ['i42', 'i43'],
  [ROOT_B]: ['i7'],
};

/** What the i17-runner handlers answer for a project with a live orchestrator. */
const defaultAnswer = ({ name, args }: Received): Answer => {
  const slot = args.slot as string | undefined;
  if (slot && !SLOTS[args.root as string]?.includes(slot)) {
    return { ok: false, code: 'path_not_allowed', message: 'not this project' };
  }
  switch (name) {
    case 'orchestrator.start':
      return { ok: true, output: { session: SESSION, startedAt: STARTED_AT } };
    case 'orchestrator.stop':
    case 'slot.stop':
      return { ok: true, output: { stopped: true } };
    case 'orchestrator.status':
      return {
        ok: true,
        output: {
          present: true,
          state: 'running',
          session: SESSION,
          startedAt: STARTED_AT,
        },
      };
    case 'slot.message':
      return { ok: true, output: { written: true, delivered: true } };
    default:
      return { ok: false, code: 'unknown_command' };
  }
};

/** A connected runner that answers control commands and records them. */
class FakeControlRunner {
  readonly received: Received[] = [];
  answer: (command: Received) => Answer = defaultAnswer;

  constructor(readonly socket: TestRunnerSocket) {
    void this.serve();
  }

  private async serve(): Promise<void> {
    for (;;) {
      let command: Awaited<ReturnType<TestRunnerSocket['next']>>;
      try {
        command = await this.socket.next('command', 60_000);
      } catch {
        return;
      }
      const received = {
        name: command.name,
        args: command.args as Record<string, unknown>,
      };
      this.received.push(received);
      const answer = this.answer(received);
      if (answer === 'silence') continue;
      this.socket.send(
        answer.ok
          ? {
              type: 'command.result',
              id: command.id,
              ok: true,
              output: answer.output,
            }
          : {
              type: 'command.result',
              id: command.id,
              ok: false,
              error: { code: answer.code, message: answer.message },
            },
      );
    }
  }

  /** Control commands only; the runner also gets `runner.*` traffic. */
  control(): Received[] {
    return this.received.filter((r) => /^(orchestrator|slot)\./.test(r.name));
  }
}

interface ControlE2eContext extends E2eContext {
  origin: string;
}

const createControlE2eApp = async (): Promise<ControlE2eContext> => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CONTROL_OPTIONS)
    .useValue(options)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const origin = (await app.getUrl()).replace(/\/+$/, '');
  return {
    app,
    prisma: app.get(PrismaService),
    http: () => request(app.getHttpServer()),
    origin,
  };
};

describe('orchestrator and slot control (e2e)', () => {
  let ctx: ControlE2eContext;
  let admin: Session;
  let operatorOfA: Session;
  let viewerOfA: Session;
  let operatorOfB: Session;
  let outsider: Session;
  let runnerId: string;
  let runner: FakeControlRunner;
  let a: string;
  let b: string;
  let claudeProfile: string;
  let codexProfile: string;
  const sockets: { close: () => unknown }[] = [];

  const memberOf = async (
    email: string,
    projectId: string | null,
    role: 'viewer' | 'operator',
  ) => {
    const user = await createUser(ctx.prisma, email, role);
    if (projectId) {
      await ctx.prisma.projectMember.create({
        data: { projectId, userId: user.id },
      });
    }
    return login(ctx, email);
  };

  const runs = () =>
    ctx.prisma.commandRun.findMany({ orderBy: { requestedAt: 'asc' } });

  /**
   * This test's records: the audit log is append-only, so `resetDatabase`
   * leaves earlier tests' rows. Control actions carry the project, the
   * generic `runner.command` record its runner.
   */
  const audits = (action: string) =>
    ctx.prisma.auditRecord.findMany({
      where: {
        action,
        ...(action.startsWith('runner.')
          ? { targetId: runnerId }
          : { projectId: a }),
      },
      orderBy: { seq: 'asc' },
    });

  /** The whole audit log as text, to search for what must not be in it. */
  const auditLog = async () =>
    JSON.stringify(await ctx.prisma.auditRecord.findMany(), (_, v) =>
      typeof v === 'bigint' ? `${v}` : v,
    );

  const liveOn = async (session: Session, projectId: string) => {
    const live = new TestLiveSocket(
      `${ctx.origin.replace(/^http/, 'ws')}/live`,
      {
        token: session.token,
        origin: allowedLiveOrigin(),
      },
    );
    sockets.push({ close: () => live.socket.close() });
    await live.ready();
    expect((await live.subscribe(`project:${projectId}`)).type).toBe(
      'subscribed',
    );
    return live;
  };

  beforeAll(async () => {
    ctx = await createControlE2eApp();
  });
  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    admin = await adminSession(ctx);
    const paired = await pairedRunner(ctx, admin);
    runnerId = paired.runnerId;
    const socket = new TestRunnerSocket(ctx.origin, paired.token);
    sockets.push({ close: () => socket.socket.close() });
    await socket.connect(
      hello({
        capabilities: {
          ...capabilities,
          profiles: [
            ...capabilities.profiles,
            {
              id: 'codex-main',
              runtime: 'codex',
              env: {},
              args: [],
              authenticated: true,
            },
          ],
        },
      }),
    );
    runner = new FakeControlRunner(socket);
    ({ projectId: a } = await seedProject(ctx.prisma, ROOT_A, runnerId));
    ({ projectId: b } = await seedProject(ctx.prisma, ROOT_B, runnerId));
    const profiles = await ctx.prisma.runtimeProfile.findMany({
      where: { runnerId },
    });
    claudeProfile = profiles.find((p) => p.key === 'claude-main')?.id ?? '';
    codexProfile = profiles.find((p) => p.key === 'codex-main')?.id ?? '';
    await ctx.prisma.project.update({
      where: { id: a },
      data: { defaultProfileId: claudeProfile },
    });
    operatorOfA = await memberOf('operator-a@example.com', a, 'operator');
    viewerOfA = await memberOf('viewer-a@example.com', a, 'viewer');
    operatorOfB = await memberOf('operator-b@example.com', b, 'operator');
    outsider = await memberOf('outsider@example.com', null, 'operator');
  });

  const start = (session: Session, body: object = { mode: 'start' }) =>
    session.send('post', `/projects/${a}/orchestrator/start`, body);

  describe('authorization (D9)', () => {
    const routes = (projectId: string) =>
      [
        ['post', `/projects/${projectId}/orchestrator/start`],
        ['post', `/projects/${projectId}/orchestrator/stop`],
        ['get', `/projects/${projectId}/orchestrator/status`],
        ['get', `/projects/${projectId}/orchestrator/settings`],
        ['put', `/projects/${projectId}/orchestrator/settings`],
        ['post', `/projects/${projectId}/slots/i42/stop`],
        ['post', `/projects/${projectId}/slots/i42/message`],
        ['get', `/projects/${projectId}/command-runs`],
      ] as const;
    const body = { mode: 'start', text: 'hello' };
    const call = (
      session: Session,
      method: 'get' | 'post' | 'put',
      path: string,
    ) =>
      method === 'get' ? session.get(path) : session.send(method, path, body);

    it('answers 401 to an anonymous caller on every route', async () => {
      for (const [method, path] of routes(a)) {
        const response = await ctx.http()[method](path).send(body);
        expect([method, path, response.status]).toEqual([method, path, 401]);
      }
    });

    it('answers 404 to a non-member and to a member of another project, on every route', async () => {
      for (const session of [outsider, operatorOfB]) {
        for (const [method, path] of routes(a)) {
          const response = await call(session, method, path);
          expect([method, path, response.status]).toEqual([method, path, 404]);
          expect(response.body.error).toBe('not_found');
        }
      }
      // A malformed slot does not reveal the project either.
      const response = await outsider.send(
        'post',
        `/projects/${a}/slots/BAD/stop`,
      );
      expect(response.status).toBe(404);
      expect(runner.control()).toEqual([]);
    });

    it('answers 403 to a viewer on every command and the settings write; lets them read', async () => {
      for (const [method, path] of routes(a)) {
        const response = await call(viewerOfA, method, path);
        const expected = method === 'get' ? 200 : 403;
        expect([method, path, response.status]).toEqual([
          method,
          path,
          expected,
        ]);
      }
      expect(runner.control().map((r) => r.name)).toEqual([
        'orchestrator.status',
      ]);
      expect(await runs()).toEqual([]);
    });
  });

  describe('POST orchestrator/start (D2, D3)', () => {
    it('sends D3 defaults with the project’s default profile, logs the run, audits it and publishes both states', async () => {
      const live = await liveOn(viewerOfA, a);
      const response = await start(operatorOfA);
      expect(response.status).toBe(201);
      const run = response.body as CommandRunView;
      expect(run).toMatchObject({
        projectId: a,
        command: 'orchestrator.start',
        status: 'ok',
        result: { session: SESSION, startedAt: STARTED_AT },
        user: { email: 'operator-a@example.com' },
      });
      expect(runner.control()).toEqual([
        {
          name: 'orchestrator.start',
          args: {
            projectId: a,
            root: ROOT_A,
            profileId: 'claude-main',
            model: 'opus',
            permissionMode: 'auto',
            mode: 'start',
          },
        },
      ]);

      const [row] = await runs();
      expect(row).toMatchObject({ id: run.id, status: 'ok', runnerId });
      expect(row.finishedAt).not.toBeNull();

      const [audit] = await audits('orchestrator.start');
      expect(audit).toMatchObject({
        actorType: 'user',
        projectId: a,
        result: 'ok',
        meta: expect.objectContaining({ commandRunId: run.id }),
      });

      const first = await live.next('event');
      const second = await live.next('event');
      expect([first.event, second.event]).toEqual([
        COMMAND_RUN_LIVE_EVENT,
        COMMAND_RUN_LIVE_EVENT,
      ]);
      expect([
        (first.data as CommandRunView).status,
        (second.data as CommandRunView).status,
      ]).toEqual(['requested', 'ok']);
      expect(first.data).not.toHaveProperty('args');
    });

    it('takes the project settings, then the request overrides', async () => {
      await admin.send('put', `/projects/${a}/orchestrator/settings`, {
        model: 'sonnet',
        permissionMode: 'acceptEdits',
      });
      expect((await start(operatorOfA, { mode: 'next' })).status).toBe(201);
      expect(
        (await start(operatorOfA, { mode: 'next', model: 'claude-opus-5-5' }))
          .status,
      ).toBe(201);
      expect(runner.control().map((r) => r.args)).toEqual([
        expect.objectContaining({
          model: 'sonnet',
          permissionMode: 'acceptEdits',
          mode: 'next',
        }),
        expect.objectContaining({
          model: 'claude-opus-5-5',
          permissionMode: 'acceptEdits',
        }),
      ]);
    });

    it('answers already_running with 409 and ends the run in error', async () => {
      runner.answer = () => ({
        ok: false,
        code: 'already_running',
        message: `${SESSION} exists`,
      });
      const response = await start(operatorOfA);
      expect(response.status).toBe(409);
      const body = response.body as ControlErrorBody;
      expect(body.error).toBe('already_running');
      const [row] = await runs();
      expect(body.commandRunId).toBe(row.id);
      expect(row).toMatchObject({
        status: 'error',
        error: { code: 'already_running' },
      });
      expect((await audits('orchestrator.start'))[0].result).toBe('error');
    });

    it('refuses a codex profile with 422 unsupported_runtime before sending', async () => {
      const response = await start(operatorOfA, {
        mode: 'start',
        profileId: codexProfile,
      });
      expect(response.status).toBe(422);
      expect(response.body.error).toBe('unsupported_runtime');
      expect(runner.control()).toEqual([]);
      expect((await runs()).map((r) => r.status)).toEqual(['error']);
    });

    it('refuses a profile of another runner, and a project without any profile', async () => {
      const other = await ctx.prisma.runner.create({ data: { name: 'other' } });
      const foreign = await ctx.prisma.runtimeProfile.create({
        data: {
          runnerId: other.id,
          key: 'claude-main',
          runtime: 'claude',
          label: 'claude-main',
          env: {},
          args: [],
          authenticated: true,
        },
      });
      const response = await start(operatorOfA, {
        mode: 'start',
        profileId: foreign.id,
      });
      expect([response.status, response.body.error]).toEqual([
        422,
        'unknown_profile',
      ]);

      await ctx.prisma.project.update({
        where: { id: a },
        data: { defaultProfileId: null },
      });
      const none = await start(operatorOfA);
      expect([none.status, none.body.error]).toEqual([422, 'no_profile']);
      expect(runner.control()).toEqual([]);
    });

    it('answers 400 to a model that reads as a flag, with nothing recorded', async () => {
      const response = await start(operatorOfA, {
        mode: 'start',
        model: '--dangerously-skip-permissions',
      });
      expect(response.status).toBe(400);
      expect(await runs()).toEqual([]);
    });
  });

  describe('bypassPermissions is admin-only (D3)', () => {
    it('refuses the setting to an operator with 403 and audits the denial', async () => {
      const response = await operatorOfA.send(
        'put',
        `/projects/${a}/orchestrator/settings`,
        { permissionMode: 'bypassPermissions' },
      );
      expect(response.status).toBe(403);
      expect(
        (
          (await viewerOfA.get(`/projects/${a}/orchestrator/settings`))
            .body as OrchestratorSettingsView
        ).permissionMode,
      ).toBe('auto');
      const [audit] = await audits('orchestrator.settings');
      expect(audit.result).toBe('denied');
    });

    it('lets an admin set it, audits it, and an operator then starts with it', async () => {
      const response = await admin.send(
        'put',
        `/projects/${a}/orchestrator/settings`,
        { permissionMode: 'bypassPermissions' },
      );
      expect(response.status).toBe(200);
      expect((response.body as OrchestratorSettingsView).permissionMode).toBe(
        'bypassPermissions',
      );
      const [audit] = await audits('orchestrator.settings');
      expect(audit).toMatchObject({
        result: 'ok',
        before: expect.objectContaining({ permissionMode: 'auto' }),
        after: expect.objectContaining({ permissionMode: 'bypassPermissions' }),
      });

      expect((await start(operatorOfA)).status).toBe(201);
      expect(runner.control()[0].args.permissionMode).toBe('bypassPermissions');
    });

    it('refuses a bypass override on start to an operator, and sends it for an admin', async () => {
      const body = { mode: 'start', permissionMode: 'bypassPermissions' };
      const refused = await start(operatorOfA, body);
      expect([refused.status, refused.body.error]).toEqual([403, 'forbidden']);
      expect(runner.control()).toEqual([]);
      expect((await audits('orchestrator.start'))[0].result).toBe('denied');

      expect((await start(admin, body)).status).toBe(201);
      expect(runner.control()[0].args.permissionMode).toBe('bypassPermissions');
      expect((await audits('orchestrator.start')).map((r) => r.result)).toEqual(
        ['denied', 'ok'],
      );
    });

    it('refuses a codex profile in the settings with 422', async () => {
      const response = await operatorOfA.send(
        'put',
        `/projects/${a}/orchestrator/settings`,
        { profileId: codexProfile },
      );
      expect([response.status, response.body.error]).toEqual([
        422,
        'unsupported_runtime',
      ]);
    });
  });

  describe('POST orchestrator/stop and GET status (D4, D5)', () => {
    it('stops the orchestrator session through the runner', async () => {
      const response = await operatorOfA.send(
        'post',
        `/projects/${a}/orchestrator/stop`,
      );
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        command: 'orchestrator.stop',
        status: 'ok',
        result: { stopped: true },
      });
      expect(runner.control()).toEqual([
        { name: 'orchestrator.stop', args: { projectId: a, root: ROOT_A } },
      ]);
      expect((await audits('orchestrator.stop'))[0].result).toBe('ok');
    });

    it('reads the status live, without a run', async () => {
      const response = await viewerOfA.get(
        `/projects/${a}/orchestrator/status`,
      );
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        present: true,
        state: 'running',
        session: SESSION,
        startedAt: STARTED_AT,
      });
      expect(await runs()).toEqual([]);
    });
  });

  describe('POST slots/:slot/stop (D6)', () => {
    it('stops a slot of this project', async () => {
      const response = await operatorOfA.send(
        'post',
        `/projects/${a}/slots/i42/stop`,
      );
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ slot: 'i42', status: 'ok' });
      expect(runner.control()).toEqual([
        {
          name: 'slot.stop',
          args: { projectId: a, root: ROOT_A, slot: 'i42' },
        },
      ]);
      const [audit] = await audits('slot.stop');
      expect(audit).toMatchObject({
        targetType: 'slot',
        targetId: 'i42',
        projectId: a,
        result: 'ok',
      });
    });

    it.each([
      ['uppercase', 'I42'],
      ['dots', 'a..b'],
      ['a slash', 'a%2Fb'],
      ['a leading dash', '-x'],
    ])('rejects a slot name with %s as invalid_args before anything runs', async (_, slot) => {
      const response = await operatorOfA.send(
        'post',
        `/projects/${a}/slots/${slot}/stop`,
      );
      expect([response.status, response.body.error]).toEqual([
        400,
        'invalid_args',
      ]);
      expect(runner.control()).toEqual([]);
      expect(await runs()).toEqual([]);
    });

    it('cannot stop project B’s slot through project A’s route', async () => {
      const response = await operatorOfA.send(
        'post',
        `/projects/${a}/slots/i7/stop`,
      );
      expect([response.status, response.body.error]).toEqual([
        403,
        'path_not_allowed',
      ]);
      // A's root went to the runner, never B's.
      expect(runner.control()).toEqual([
        { name: 'slot.stop', args: { projectId: a, root: ROOT_A, slot: 'i7' } },
      ]);
      expect((await runs())[0]).toMatchObject({
        projectId: a,
        status: 'error',
        error: { code: 'path_not_allowed' },
      });
    });
  });

  describe('POST slots/:slot/message (D7, D8, D10)', () => {
    const message = (text = SECRET_TEXT) =>
      operatorOfA.send('post', `/projects/${a}/slots/i42/message`, { text });

    it('sends the text with the user’s email, keeps it in the run only, and publishes slot.message_sent', async () => {
      const live = await liveOn(viewerOfA, a);
      const response = await message();
      expect(response.status).toBe(201);
      const run = response.body as CommandRunView;
      expect(run).toMatchObject({
        status: 'ok',
        slot: 'i42',
        args: { text: SECRET_TEXT },
        result: { written: true, delivered: true },
      });
      expect(runner.control()).toEqual([
        {
          name: 'slot.message',
          args: {
            projectId: a,
            root: ROOT_A,
            slot: 'i42',
            text: SECRET_TEXT,
            from: 'operator-a@example.com',
          },
        },
      ]);

      const events = [];
      for (let i = 0; i < 3; i += 1) events.push(await live.next('event'));
      const sent = events.find((e) => e.event === SLOT_MESSAGE_SENT_LIVE_EVENT);
      expect(sent?.data).toMatchObject({
        projectId: a,
        slot: 'i42',
        commandRunId: run.id,
        delivered: true,
      });

      const [audit] = await audits('slot.message');
      expect(audit.result).toBe('ok');
      expect((audit.after as { args: { text: string } }).args.text).toMatch(
        /^sha256:[0-9a-f]{64}$/,
      );
      const [command] = await audits('runner.command');
      expect((command.after as { args: { text: string } }).args.text).toBe(
        (audit.after as { args: { text: string } }).args.text,
      );
      // The text appears nowhere in the audit log.
      expect(await auditLog()).not.toContain('tangerine-42');
    });

    it('keeps the text out of the audit log when the runner is offline too', async () => {
      await runner.socket.close();
      await eventually('runner offline', async () =>
        (await admin.get(`/admin/runners/${runnerId}`)).body.status ===
        'offline'
          ? true
          : undefined,
      );
      const response = await message();
      expect([response.status, response.body.error]).toEqual([
        409,
        'runner_offline',
      ]);
      const [row] = await runs();
      expect(response.body.commandRunId).toBe(row.id);
      expect(row).toMatchObject({
        status: 'error',
        error: { code: 'runner_offline' },
      });
      expect(await auditLog()).not.toContain('tangerine-42');
      expect((await audits('slot.message'))[0].result).toBe('error');
    });

    it('answers 400 to a blank message, with nothing recorded', async () => {
      const response = await message('   \n ');
      expect(response.status).toBe(400);
      expect(runner.control()).toEqual([]);
      expect(await runs()).toEqual([]);
    });
  });

  describe('a runner that never answers', () => {
    it('leaves the run unknown after the timeout and answers 504', async () => {
      runner.answer = () => 'silence';
      const response = await operatorOfA.send(
        'post',
        `/projects/${a}/slots/i42/stop`,
      );
      expect([response.status, response.body.error]).toEqual([
        504,
        'runner_timeout',
      ]);
      const [row] = await runs();
      expect(row).toMatchObject({
        status: 'unknown',
        error: { code: 'runner_timeout' },
      });
      expect(row.finishedAt).not.toBeNull();
      expect((await audits('slot.stop'))[0].result).toBe('error');
    });
  });

  describe('GET command-runs', () => {
    it('pages the log newest first and keeps projects apart', async () => {
      for (const slot of ['i42', 'i43', 'i42']) {
        await operatorOfA.send('post', `/projects/${a}/slots/${slot}/stop`);
      }
      await operatorOfB.send('post', `/projects/${b}/slots/i7/stop`);

      const first = (await viewerOfA.get(`/projects/${a}/command-runs?limit=2`))
        .body as CommandRunPage;
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = (
        await viewerOfA.get(
          `/projects/${a}/command-runs?limit=2&cursor=${first.nextCursor}`,
        )
      ).body as CommandRunPage;
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      const all = [...first.items, ...second.items];
      expect(all.map((r) => r.projectId)).toEqual([a, a, a]);
      expect(all.map((r) => r.slot)).toEqual(['i42', 'i43', 'i42']);

      const foreign = (await runs()).find((r) => r.projectId === b);
      const response = await viewerOfA.get(
        `/projects/${a}/command-runs?cursor=${foreign?.id}`,
      );
      expect([response.status, response.body.error]).toEqual([
        400,
        'invalid_args',
      ]);
    });
  });
});
