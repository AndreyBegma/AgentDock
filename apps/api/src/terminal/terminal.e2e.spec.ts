import { TERMINAL_CLOSE_CODES } from '@agentdock/shared';
import {
  TERMINAL_WS_PATH,
  type TerminalAttachArgs,
} from '@agentdock/shared/protocol';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../app.module';
import { configureApp } from '../configure-app';
import { PrismaService } from '../database/prisma.service';
import { allowedLiveOrigin } from '../live/live-options';
import { capabilities } from '../runners/testing/runner-e2e';
import {
  createUser,
  type E2eContext,
  login,
  resetDatabase,
  type Session,
} from '../test/e2e-app';
import { TERMINAL_OPTIONS, type TerminalOptions } from './terminal-options';
import { TerminalRelay } from './terminal-relay';
import {
  TERMINAL_RUNNER_PORT,
  type TerminalAttachOutcome,
  type TerminalRunnerPort,
  type TerminalToRunner,
} from './terminal-runner-port';
import {
  waitFor as eventually,
  TestTerminalSocket,
} from './testing/terminal-e2e';

const TICKET_TTL_MS = 400;
const SECRET = 'typed-secret-marker-7731';

/** `JSON.stringify` of rows that hold `BigInt` columns. */
const json = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  );

/**
 * The runner side, played in-process so these tests reach every refusal and
 * limit directly; `terminal-runner.e2e.spec.ts` goes through a real runner socket.
 */
class FakeRunnerPort implements TerminalRunnerPort {
  readonly attaches: TerminalAttachArgs[] = [];
  readonly sent: TerminalToRunner[] = [];
  outcome: TerminalAttachOutcome = { status: 'ok', session: 'cs-i42' };

  async attach(
    _runnerId: string,
    args: TerminalAttachArgs,
  ): Promise<TerminalAttachOutcome> {
    this.attaches.push(args);
    return this.outcome;
  }

  send(_runnerId: string, message: TerminalToRunner): boolean {
    this.sent.push(message);
    return true;
  }

  reset(): void {
    this.attaches.length = 0;
    this.sent.length = 0;
    this.outcome = { status: 'ok', session: 'cs-i42' };
  }
}

describe('terminal attach (e2e)', () => {
  let ctx: E2eContext;
  let wsBase: string;
  let port: FakeRunnerPort;
  let admin: Session;
  let adminId: string;
  let projectId: string;
  let runnerId: string;
  const sockets: TestTerminalSocket[] = [];
  let auditFrom = 0n;

  const terminalAudit = () =>
    ctx.prisma.auditRecord.findMany({
      where: { seq: { gt: auditFrom }, action: { startsWith: 'terminal.' } },
      orderBy: { seq: 'asc' },
    });

  const writeSlot = () => ({
    kind: 'slot',
    projectId,
    slot: 'i42',
    mode: 'write',
  });

  const ticket = async (
    session: Session,
    body: object = { kind: 'slot', projectId, slot: 'i42', mode: 'read' },
  ) => session.send('post', '/terminal/tickets', body);

  const issued = async (session: Session = admin, body?: object) => {
    const response = await ticket(session, body);
    if (response.status !== 201) {
      throw new Error(`ticket → ${response.status} ${response.text}`);
    }
    return (response.body as { ticket: string }).ticket;
  };

  const connect = (
    value: string | null,
    {
      token = admin.token,
      origin = allowedLiveOrigin(),
    }: { token?: string; origin?: string } = {},
  ) => {
    const query = value === null ? '' : `?ticket=${encodeURIComponent(value)}`;
    const socket = new TestTerminalSocket(`${wsBase}${query}`, {
      token,
      origin,
    });
    sockets.push(socket);
    return socket;
  };

  const signIn = async (
    email: string,
    role: 'admin' | 'operator' | 'viewer',
  ): Promise<{ id: string; session: Session }> => {
    const user = await createUser(ctx.prisma, email, role);
    return { id: user.id, session: await login(ctx, email) };
  };

  beforeAll(async () => {
    port = new FakeRunnerPort();
    const options: TerminalOptions = {
      ticketTtlMs: TICKET_TTL_MS,
      idleTimeoutMs: 60_000,
      maxDurationMs: 600_000,
      revalidateMs: 60_000,
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TERMINAL_OPTIONS)
      .useValue(options)
      .overrideProvider(TERMINAL_RUNNER_PORT)
      .useValue(port)
      .compile();
    const app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    const origin = (await app.getUrl()).replace(/\/+$/, '');
    ctx = {
      app,
      prisma: app.get(PrismaService),
      http: () => request(app.getHttpServer()),
    };
    wsBase = `${origin.replace(/^http/, 'ws')}${TERMINAL_WS_PATH}`;
  });
  afterAll(() => ctx.app.close());

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    port.reset();
    const signedIn = await signIn('admin@example.com', 'admin');
    admin = signedIn.session;
    adminId = signedIn.id;
    const runner = await ctx.prisma.runner.create({
      data: { name: 'desk', capabilities: { ...capabilities, terminal: true } },
    });
    runnerId = runner.id;
    const project = await ctx.prisma.project.create({
      data: {
        runnerId,
        rootPath: '/srv/dev/widget',
        repo: 'acme/widget',
        displayName: 'widget',
        baseBranch: 'develop',
        baseSource: 'config',
        hasClaudeMd: true,
        hasAgentsMd: false,
        lastInspectedAt: new Date('2026-10-01T00:00:00Z'),
      },
    });
    projectId = project.id;
    const last = await ctx.prisma.auditRecord.findFirst({
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    auditFrom = last?.seq ?? 0n;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.socket.terminate();
    // Every attach a test left open is ended before the next test truncates.
    await eventually(
      () => ctx.app.get(TerminalRelay).active(projectId).length === 0,
    );
  });

  describe('POST /terminal/tickets', () => {
    it('gives an admin a single-use ticket that expires after the TTL', async () => {
      const before = Date.now();
      const response = await ticket(admin);
      expect(response.status).toBe(201);
      const body = response.body as { ticket: string; expiresAt: string };
      expect(Buffer.from(body.ticket, 'base64url')).toHaveLength(32);
      const expiresAt = Date.parse(body.expiresAt);
      expect(expiresAt).toBeGreaterThanOrEqual(before + TICKET_TTL_MS);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + TICKET_TTL_MS);
    });

    it('is 403 for an operator and a viewer, even as project members', async () => {
      for (const role of ['operator', 'viewer'] as const) {
        const user = await signIn(`${role}@example.com`, role);
        await ctx.prisma.projectMember.create({
          data: { projectId, userId: user.id },
        });
        expect((await ticket(user.session)).status).toBe(403);
      }
    });

    it('is 401 anonymously and 403 without the CSRF header', async () => {
      const anonymous = await ctx
        .http()
        .post('/terminal/tickets')
        .send({ kind: 'orchestrator', projectId, mode: 'read' });
      expect(anonymous.status).toBe(401);
      const noCsrf = await admin.sendWithoutCsrf('post', '/terminal/tickets');
      expect(noCsrf.status).toBe(403);
    });

    it('is 404 for a project that does not exist', async () => {
      const response = await ticket(admin, {
        kind: 'orchestrator',
        projectId: 'no-such-project',
        mode: 'read',
      });
      expect(response.status).toBe(404);
    });

    it('takes no session name, no command, and only the ids its kind needs', async () => {
      for (const body of [
        { kind: 'slot', projectId, slot: 'i42', mode: 'read', session: 'x' },
        { kind: 'slot', projectId, slot: 'i42', mode: 'read', command: 'sh' },
        { kind: 'slot', projectId, mode: 'read' },
        { kind: 'slot', projectId, slot: '../etc', mode: 'read' },
        { kind: 'orchestrator', projectId, slot: 'i42', mode: 'read' },
        { kind: 'skill_run', projectId, mode: 'read' },
        { kind: 'shell', projectId, mode: 'read' },
        { kind: 'orchestrator', projectId, mode: 'admin' },
      ]) {
        expect((await ticket(admin, body)).status).toBe(400);
      }
    });

    it('is 409 unsupported when the runner reports terminal: false', async () => {
      await ctx.prisma.runner.update({
        where: { id: runnerId },
        data: { capabilities: { ...capabilities, terminal: false } },
      });
      const response = await ticket(admin);
      expect(response.status).toBe(409);
      expect(response.body).toEqual(
        expect.objectContaining({ error: 'unsupported' }),
      );
    });
  });

  describe('GET /terminal/active', () => {
    it('is 403 for an operator and a viewer', async () => {
      for (const role of ['operator', 'viewer'] as const) {
        const user = await signIn(`${role}@example.com`, role);
        await ctx.prisma.projectMember.create({
          data: { projectId, userId: user.id },
        });
        const response = await user.session.get(
          `/terminal/active?projectId=${projectId}`,
        );
        expect(response.status).toBe(403);
      }
    });

    it('lists the live attaches, and is 404 for an unknown project', async () => {
      const socket = connect(await issued());
      await socket.frame('attached');
      const response = await admin.get(
        `/terminal/active?projectId=${projectId}`,
      );
      expect(response.status).toBe(200);
      expect(response.body).toEqual([
        expect.objectContaining({
          mode: 'read',
          target: { kind: 'slot', projectId, slot: 'i42', runId: null },
          user: { id: adminId, email: 'admin@example.com' },
        }),
      ]);
      const unknown = await admin.get('/terminal/active?projectId=nope');
      expect(unknown.status).toBe(404);
    });
  });

  describe('/terminal upgrade', () => {
    it('attaches with a valid ticket, cookie and Origin', async () => {
      const socket = connect(await issued());
      expect(await socket.frame('attached')).toEqual(
        expect.objectContaining({ mode: 'read', session: 'cs-i42' }),
      );
      expect(port.attaches).toEqual([
        expect.objectContaining({
          target: {
            kind: 'slot',
            projectId,
            root: '/srv/dev/widget',
            slot: 'i42',
          },
          mode: 'read',
          cols: 80,
          rows: 24,
        }),
      ]);
    });

    it('refuses an anonymous upgrade', async () => {
      const value = await issued();
      const socket = new TestTerminalSocket(`${wsBase}?ticket=${value}`, {
        origin: allowedLiveOrigin(),
      });
      sockets.push(socket);
      expect((await socket.closed).code).toBe(
        TERMINAL_CLOSE_CODES.unauthorized,
      );
      expect(port.attaches).toEqual([]);
    });

    it('refuses a foreign or missing Origin', async () => {
      for (const origin of ['http://evil.example', undefined]) {
        const value = await issued();
        const socket = new TestTerminalSocket(`${wsBase}?ticket=${value}`, {
          token: admin.token,
          origin,
        });
        sockets.push(socket);
        expect((await socket.closed).code).toBe(
          TERMINAL_CLOSE_CODES.forbiddenOrigin,
        );
      }
      expect(port.attaches).toEqual([]);
    });

    it('refuses a missing, reused or expired ticket', async () => {
      expect((await connect(null).closed).code).toBe(
        TERMINAL_CLOSE_CODES.invalidTicket,
      );

      const value = await issued();
      const first = connect(value);
      await first.frame('attached');
      expect((await connect(value).closed).code).toBe(
        TERMINAL_CLOSE_CODES.invalidTicket,
      );

      const late = await issued();
      await new Promise((resolve) => setTimeout(resolve, TICKET_TTL_MS + 50));
      expect((await connect(late).closed).code).toBe(
        TERMINAL_CLOSE_CODES.invalidTicket,
      );
      expect(port.attaches).toHaveLength(1);
    });

    it("refuses another user's ticket, and the same user's from another session", async () => {
      const other = await signIn('grace@example.com', 'admin');
      const stolen = await issued();
      expect(
        (await connect(stolen, { token: other.session.token }).closed).code,
      ).toBe(TERMINAL_CLOSE_CODES.invalidTicket);

      const secondSession = await login(ctx, 'admin@example.com');
      const value = await issued();
      expect(
        (await connect(value, { token: secondSession.token }).closed).code,
      ).toBe(TERMINAL_CLOSE_CODES.invalidTicket);
      expect(port.attaches).toEqual([]);
    });

    it('refuses an admin demoted after the ticket was issued', async () => {
      const value = await issued();
      await ctx.prisma.user.update({
        where: { id: adminId },
        data: { role: 'operator' },
      });
      expect((await connect(value).closed).code).toBe(
        TERMINAL_CLOSE_CODES.forbidden,
      );
      expect(port.attaches).toEqual([]);
    });

    it('passes the runner refusal on: not_found closes 4404', async () => {
      port.outcome = { status: 'error', code: 'not_found' };
      const socket = connect(await issued());
      expect(await socket.frame('error')).toEqual({
        type: 'error',
        code: 'not_found',
      });
      expect((await socket.closed).code).toBe(TERMINAL_CLOSE_CODES.notFound);
      await eventually(async () => (await terminalAudit()).length === 1);
      expect(await terminalAudit()).toEqual([
        expect.objectContaining({
          action: 'terminal.attached',
          result: 'error',
          meta: expect.objectContaining({ refusal: 'not_found' }),
        }),
      ]);
    });
  });

  describe('relay', () => {
    it('drops a read attach input before the runner, and relays output as binary', async () => {
      const socket = connect(await issued());
      const attached = await socket.frame('attached');
      socket.socket.send(Buffer.from('echo hi\r'), { binary: true });
      socket.socket.send(
        JSON.stringify({ type: 'resize', cols: 120, rows: 40 }),
      );
      await eventually(() =>
        port.sent.some((m) => m.type === 'terminal.resize'),
      );
      expect(port.sent.filter((m) => m.type === 'terminal.data')).toEqual([]);

      ctx.app.get(TerminalRelay).fromRunner(runnerId, {
        type: 'terminal.data',
        id: attached.id,
        b64: Buffer.from('$ ').toString('base64'),
      });
      await eventually(() => socket.data.length > 0);
      expect(Buffer.concat(socket.data).toString()).toBe('$ ');
    });

    it('forwards write input, and a second write attach to the target is busy', async () => {
      const socket = connect(await issued(admin, writeSlot()));
      const attached = await socket.frame('attached');
      socket.socket.send(Buffer.from('ls\r'), { binary: true });
      await eventually(() => port.sent.some((m) => m.type === 'terminal.data'));
      expect(port.sent.find((m) => m.type === 'terminal.data')).toEqual({
        type: 'terminal.data',
        id: attached.id,
        b64: Buffer.from('ls\r').toString('base64'),
      });

      const response = await ticket(admin, writeSlot());
      expect(response.status).toBe(409);
      expect(response.body).toEqual(
        expect.objectContaining({
          error: 'busy',
          heldBy: { id: adminId, email: 'admin@example.com' },
        }),
      );
    });

    it('closing the socket ends the attach on the runner and audits both modes with byte counts — never the bytes', async () => {
      const read = connect(await issued());
      const readAttach = await read.frame('attached');
      read.socket.close();
      await eventually(() =>
        port.sent.some(
          (m) => m.type === 'terminal.close' && m.id === readAttach.id,
        ),
      );

      const write = connect(await issued(admin, writeSlot()));
      const writeAttach = await write.frame('attached');
      write.socket.send(Buffer.from(SECRET), { binary: true });
      await eventually(() => port.sent.some((m) => m.type === 'terminal.data'));
      ctx.app.get(TerminalRelay).fromRunner(runnerId, {
        type: 'terminal.data',
        id: writeAttach.id,
        b64: Buffer.from(SECRET).toString('base64'),
      });
      await eventually(() => write.data.length > 0);
      write.socket.send(JSON.stringify({ type: 'close' }));
      expect(await write.closed).toEqual({
        code: TERMINAL_CLOSE_CODES.ended,
        reason: 'client',
      });

      await eventually(async () => (await terminalAudit()).length === 4);
      const records = await terminalAudit();
      expect(records.map((r) => [r.action, r.result])).toEqual([
        ['terminal.attached', 'ok'],
        ['terminal.detached', 'ok'],
        ['terminal.attached', 'ok'],
        ['terminal.detached', 'ok'],
      ]);
      expect(records.map((r) => (r.after as { mode?: string }).mode)).toEqual([
        'read',
        undefined,
        'write',
        undefined,
      ]);
      expect(records[3].after).toEqual(
        expect.objectContaining({
          reason: 'client',
          bytesIn: SECRET.length,
          bytesOut: SECRET.length,
          durationMs: expect.any(Number),
        }),
      );
      const stored = json(
        await ctx.prisma.auditRecord.findMany({
          where: { seq: { gt: auditFrom } },
        }),
      );
      expect(stored).not.toContain(SECRET);
      expect(stored).not.toContain(Buffer.from(SECRET).toString('base64'));
      expect(json(await ctx.prisma.event.findMany())).not.toContain(SECRET);
    });
  });
});
