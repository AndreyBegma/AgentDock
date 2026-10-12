import { TERMINAL_CLOSE_CODES } from '@agentdock/shared';
import {
  type CommandErrorCode,
  TERMINAL_WS_PATH,
  type TerminalMode,
} from '@agentdock/shared/protocol';
import { allowedLiveOrigin } from '../live/live-options';
import {
  adminSession,
  CapturingLogger,
  capabilities,
  createRunnerE2eApp,
  hello,
  pairedRunner,
  type RunnerE2eContext,
  TestRunnerSocket,
} from '../runners/testing/runner-e2e';
import { resetDatabase, type Session } from '../test/e2e-app';
import { TerminalRelay } from './terminal-relay';
import { TestTerminalSocket, waitFor } from './testing/terminal-e2e';

const ROOT = '/srv/dev/widget';
const SECRET = 'typed-through-runner-5512';
const b64 = (text: string) => Buffer.from(text).toString('base64');

/**
 * The relay end to end: a browser on `/terminal`, the API, and a runner on
 * `/runner` played by `TestRunnerSocket` (spec 29 D5–D8).
 */
describe('terminal relay through the runner socket (e2e)', () => {
  const logger = new CapturingLogger();
  let ctx: RunnerE2eContext;
  let wsBase: string;
  let admin: Session;
  let runnerToken: string;
  let projectId: string;
  const sockets: { close(): unknown }[] = [];

  const runner = async () => {
    const socket = new TestRunnerSocket(ctx.origin, runnerToken);
    sockets.push({ close: () => socket.socket.terminate() });
    await socket.connect(
      hello({ capabilities: { ...capabilities, terminal: true } }),
    );
    return socket;
  };

  const browser = async (mode: TerminalMode = 'read') => {
    const response = await admin.send('post', '/terminal/tickets', {
      kind: 'slot',
      projectId,
      slot: 'i42',
      mode,
    });
    if (response.status !== 201) {
      throw new Error(`ticket → ${response.status} ${response.text}`);
    }
    const { ticket } = response.body as { ticket: string };
    const socket = new TestTerminalSocket(
      `${wsBase}?ticket=${ticket}&cols=120&rows=40`,
      { token: admin.token, origin: allowedLiveOrigin() },
    );
    sockets.push({ close: () => socket.socket.terminate() });
    return socket;
  };

  /** Answers the runner's `terminal.attach`, and returns its args. */
  const answerAttach = async (
    socket: TestRunnerSocket,
    error?: CommandErrorCode,
  ) => {
    const command = await socket.next('command');
    expect(command.name).toBe('terminal.attach');
    socket.send(
      error
        ? {
            type: 'command.result',
            id: command.id,
            ok: false,
            error: { code: error },
          }
        : {
            type: 'command.result',
            id: command.id,
            ok: true,
            output: { attached: true, session: 'cs-i42' },
          },
    );
    return command.args as { id: string } & Record<string, unknown>;
  };

  /** Opens an attach through the runner and returns both ends. */
  const attached = async (mode: TerminalMode = 'read') => {
    const r = await runner();
    const b = await browser(mode);
    const args = await answerAttach(r);
    await b.frame('attached');
    return { r, b, id: args.id };
  };

  beforeAll(async () => {
    ctx = await createRunnerE2eApp({}, logger);
    wsBase = `${ctx.origin.replace(/^http/, 'ws')}${TERMINAL_WS_PATH}`;
  });
  afterAll(() => ctx.app.close());

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    admin = await adminSession(ctx);
    const paired = await pairedRunner(ctx, admin);
    runnerToken = paired.token;
    const project = await ctx.prisma.project.create({
      data: {
        runnerId: paired.runnerId,
        rootPath: ROOT,
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
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await waitFor(
      () => ctx.app.get(TerminalRelay).active(projectId).length === 0,
    );
  });

  it('sends terminal.attach with only kind, ids and root — no session name, no command', async () => {
    const r = await runner();
    await browser('read');
    const args = await answerAttach(r);
    expect(args).toEqual({
      id: expect.stringMatching(/^term_/),
      target: { kind: 'slot', projectId, root: ROOT, slot: 'i42' },
      mode: 'read',
      cols: 120,
      rows: 40,
    });
  });

  it('relays output to the browser and write input, resize and detach to the runner', async () => {
    const { r, b, id } = await attached('write');
    r.send({ type: 'terminal.data', id, b64: b64('$ ') });
    await waitFor(() => b.output === '$ ');

    b.socket.send(Buffer.from('ls\r'), { binary: true });
    expect(await r.next('terminal.data')).toEqual({
      type: 'terminal.data',
      id,
      b64: b64('ls\r'),
    });

    b.socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    expect(await r.next('terminal.resize')).toEqual({
      type: 'terminal.resize',
      id,
      cols: 100,
      rows: 30,
    });

    b.socket.send(JSON.stringify({ type: 'close' }));
    expect(await r.next('terminal.close')).toEqual({
      type: 'terminal.close',
      id,
      reason: 'client',
    });
    expect(await b.closed).toEqual({
      code: TERMINAL_CLOSE_CODES.ended,
      reason: 'client',
    });
  });

  it('never sends a read attach input to the runner', async () => {
    const { r, b, id } = await attached('read');
    b.socket.send(Buffer.from('rm -rf /\r'), { binary: true });
    b.socket.send(JSON.stringify({ type: 'resize', cols: 90, rows: 20 }));
    // The resize was sent after the input: once it arrives, the input would have.
    expect(await r.next('terminal.resize')).toEqual(
      expect.objectContaining({ id }),
    );
    await expect(r.next('terminal.data', 300)).rejects.toThrow(
      /no terminal.data/,
    );
  });

  it('closing the browser socket detaches on the runner', async () => {
    const { r, b, id } = await attached('read');
    b.socket.close();
    expect(await r.next('terminal.close')).toEqual({
      type: 'terminal.close',
      id,
      reason: 'client',
    });
  });

  it('a terminal.close from the runner ends the browser socket with its reason', async () => {
    const { r, b, id } = await attached('read');
    r.send({ type: 'terminal.close', id, reason: 'session_ended' });
    expect(await b.closed).toEqual({
      code: TERMINAL_CLOSE_CODES.ended,
      reason: 'session_ended',
    });
    await expect(r.next('terminal.close', 300)).rejects.toThrow();
  });

  it('the runner socket dropping ends the attach with socket', async () => {
    const { r, b } = await attached('read');
    r.socket.terminate();
    expect(await b.closed).toEqual({
      code: TERMINAL_CLOSE_CODES.ended,
      reason: 'socket',
    });
  });

  it('a runner with terminal.attach disabled refuses, and the browser is told', async () => {
    const r = await runner();
    const b = await browser('read');
    await answerAttach(r, 'disabled');
    expect(await b.frame('error')).toEqual({ type: 'error', code: 'disabled' });
    expect((await b.closed).code).toBe(TERMINAL_CLOSE_CODES.unsupported);
  });

  it('a runner busy at its cap refuses with busy', async () => {
    const r = await runner();
    const b = await browser('read');
    await answerAttach(r, 'busy');
    expect((await b.closed).code).toBe(TERMINAL_CLOSE_CODES.busy);
  });

  it('keeps terminal bytes out of the audit log, the events and the API logs', async () => {
    // The audit chain is append-only: read only what this test adds.
    const last = await ctx.prisma.auditRecord.findFirst({
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    const from = last?.seq ?? 0n;
    const { r, b, id } = await attached('write');
    b.socket.send(Buffer.from(SECRET), { binary: true });
    await r.next('terminal.data');
    r.send({ type: 'terminal.data', id, b64: b64(SECRET) });
    await waitFor(() => b.output.includes(SECRET));
    b.socket.close();
    await r.next('terminal.close');

    const actions = async () =>
      (
        await ctx.prisma.auditRecord.findMany({
          where: { seq: { gt: from }, action: { startsWith: 'terminal.' } },
          orderBy: { seq: 'asc' },
        })
      ).map((record) => record.action);
    await waitFor(async () => (await actions()).length === 2);
    expect(await actions()).toEqual(['terminal.attached', 'terminal.detached']);

    const json = (value: unknown) =>
      JSON.stringify(value, (_key, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v,
      );
    const everything = [
      json(await ctx.prisma.auditRecord.findMany()),
      json(await ctx.prisma.event.findMany()),
      logger.lines.join('\n'),
    ].join('\n');
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(b64(SECRET));
  });
});
