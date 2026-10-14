import {
  type LocalMethodName,
  type LocalResponseMessage,
  localMethodNames,
  localMethods,
  MANUAL_HANDOFF_EVENT,
  MANUAL_NOTE_EVENT,
} from '@agentdock/shared/protocol';
import { seedProject } from '../fleet/testing/fleet-e2e';
import {
  adminSession,
  createRunnerE2eApp,
  pairedRunner,
  type RunnerE2eContext,
  TestRunnerSocket,
} from '../runners/testing/runner-e2e';
import { createUser, resetDatabase, type Session } from '../test/e2e-app';

const ROOT = '/srv/dev/widget';
const OTHER_ROOT = '/srv/dev/gadget';
const ISSUE_URL = 'https://github.com/acme/widget/issues';

/** The args each method is called with in the all-methods sweep. */
const ARGS: Record<LocalMethodName, unknown> = {
  'context.sessionStart': { gitBranch: 'feat/12-pairing' },
  'fleet.status': {},
  'queue.list': { limit: 5 },
  'budget.remaining': {},
  'approvals.list': {},
  'activity.recent': {},
  'sessions.recent': { limit: 3 },
  'action.status': { id: 'set below' },
  'issue.create': {
    title: 'Flaky pairing test',
    body: 'Seen twice today.',
    labels: ['bug'],
    queue: false,
  },
  'activity.note': { text: 'Investigating the pairing flake' },
  'handoff.create': {
    title: 'Finish the pairing fix',
    body: 'The test fails on macOS.\n\n## Acceptance criteria\n\n- [ ] it passes',
    branch: 'fix/12-pairing',
  },
  'action.request': {
    kind: 'orchestrator_start',
    args: { mode: 'next' },
    summary: 'Start the fleet on the ready queue',
  },
  'away.set': { on: true },
};

/**
 * Spec 201 D6–D8 through the real gateway: a runner socket sends
 * `local.request` frames and gets `local.response` back. Every method of the
 * allowlist answers with a result its schema accepts; the writes that send the
 * runner a command (`issue.create`) do not deadlock the socket's frame queue.
 */
describe('local requests over the runner socket (e2e)', () => {
  let ctx: RunnerE2eContext;
  let admin: Session;
  let runnerId: string;
  let projectId: string;
  let otherRunnerProject: string;
  let localUserId: string;
  let socket: TestRunnerSocket;
  let commands: { name: string; args: Record<string, unknown> }[];
  let nextId = 0;

  const ask = async (
    method: string,
    args: unknown,
    project: string | null = projectId,
  ): Promise<LocalResponseMessage> => {
    nextId += 1;
    const id = `lr_${nextId}`;
    socket.send({
      type: 'local.request',
      id,
      method,
      args,
      ...(project ? { projectId: project } : {}),
      session: { runtime: 'claude', id: 'sess-manual-1' },
      via: 'mcp',
    });
    for (;;) {
      const response = await socket.next('local.response', 10_000);
      if (response.id === id) return response;
    }
  };

  /** Answers `issue.create` like the runner's handler, numbering from 100. */
  const serveCommands = async () => {
    let number = 100;
    for (;;) {
      let command: Awaited<ReturnType<TestRunnerSocket['next']>>;
      try {
        command = await socket.next('command', 60_000);
      } catch {
        return;
      }
      const args = command.args as Record<string, unknown>;
      commands.push({ name: command.name, args });
      number += 1;
      socket.send(
        command.name === 'issue.create'
          ? {
              type: 'command.result',
              id: command.id,
              ok: true,
              output: {
                number,
                url: `${ISSUE_URL}/${number}`,
                queued: args.queue === true,
              },
            }
          : {
              type: 'command.result',
              id: command.id,
              ok: false,
              error: { code: 'unknown_command' },
            },
      );
    }
  };

  beforeAll(async () => {
    ctx = await createRunnerE2eApp();
  });
  afterAll(async () => {
    socket?.socket.close();
    await ctx.app.close();
  });

  beforeEach(async () => {
    socket?.socket.close();
    await resetDatabase(ctx.prisma);
    admin = await adminSession(ctx);
    const paired = await pairedRunner(ctx, admin);
    runnerId = paired.runnerId;
    ({ projectId } = await seedProject(ctx.prisma, ROOT, runnerId));
    ({ projectId: otherRunnerProject } = await seedProject(
      ctx.prisma,
      OTHER_ROOT,
    ));
    const user = await createUser(ctx.prisma, 'me@example.com', 'operator');
    localUserId = user.id;
    await ctx.prisma.projectMember.create({
      data: { projectId, userId: user.id },
    });
    const patched = await admin.send('patch', `/admin/runners/${runnerId}`, {
      localUserId,
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ localUserId, awayMode: false });

    socket = new TestRunnerSocket(ctx.origin, paired.token);
    await socket.connect();
    commands = [];
    void serveCommands();
  });

  it('answers every method of the allowlist with a result its schema accepts', async () => {
    await ctx.prisma.issueCache.create({
      data: {
        projectId,
        number: 12,
        title: 'Pairing fails on macOS',
        state: 'open',
        labels: ['bug'],
        assignees: [],
        body: '',
        url: `${ISSUE_URL}/12`,
        ghUpdatedAt: new Date(),
        snapshotAt: new Date(),
        lastSeq: 1n,
      },
    });
    const responses = new Map<LocalMethodName, LocalResponseMessage>();
    let actionId = '';
    // `action.request` first: `action.status` asks about the request it made.
    const order = [
      'action.request',
      ...localMethodNames.filter((m) => m !== 'action.request'),
    ] as LocalMethodName[];
    for (const method of order) {
      const args = method === 'action.status' ? { id: actionId } : ARGS[method];
      const response = await ask(
        method,
        args,
        localMethods[method].needsProject ? projectId : null,
      );
      expect([method, response.ok, response.error]).toEqual([
        method,
        true,
        undefined,
      ]);
      expect([
        method,
        localMethods[method].result.safeParse(response.data).success,
      ]).toEqual([method, true]);
      responses.set(method, response);
      if (method === 'action.request') {
        actionId = (response.data as { id: string }).id;
      }
    }
    expect(responses.size).toBe(localMethodNames.length);

    const context = responses.get('context.sessionStart')?.data as {
      text: string;
    };
    expect(context.text).toContain('widget');
    expect(context.text).toContain('base branch develop');
    expect(context.text).toContain('#12 Pairing fails on macOS (open)');
    expect(context.text).toContain('1 pending approval');
    expect(context.text).toContain('agentdock MCP tools');

    expect(responses.get('action.status')?.data).toMatchObject({
      id: actionId,
      kind: 'orchestrator_start',
      status: 'pending',
      requestedById: localUserId,
      args: { mode: 'next' },
    });
    expect(responses.get('away.set')?.data).toEqual({ awayMode: true });

    // The writes acted as the local user, through the runner.
    expect(commands.map((c) => [c.name, c.args.queue])).toEqual([
      ['issue.create', false],
      ['issue.create', true],
    ]);
    const handoffBody = commands[1].args.body as string;
    expect(handoffBody).toContain('## Acceptance criteria');
    expect(handoffBody).toContain('Source branch: `fix/12-pairing`');
    expect(handoffBody).toContain(
      'Continue from branch `fix/12-pairing` if it exists.',
    );

    const events = await ctx.prisma.event.findMany({
      where: { type: { in: [MANUAL_NOTE_EVENT, MANUAL_HANDOFF_EVENT] } },
      orderBy: { id: 'asc' },
    });
    expect(events.map((e) => [e.type, e.source, e.data])).toEqual([
      [MANUAL_NOTE_EVENT, 'api', { text: 'Investigating the pairing flake' }],
      [MANUAL_HANDOFF_EVENT, 'api', { issue: 102, branch: 'fix/12-pairing' }],
    ]);

    const writes = await ctx.prisma.auditRecord.findMany({
      where: { action: 'local.request', actorRunnerId: runnerId },
      orderBy: { seq: 'asc' },
    });
    expect(
      writes.map((w) => [
        (w.after as { method: string }).method,
        w.result,
        (w.meta as { onBehalfOf: string }).onBehalfOf,
        (w.meta as { via: string }).via,
      ]),
    ).toEqual([
      ['action.request', 'ok', localUserId, 'mcp'],
      ['issue.create', 'ok', localUserId, 'mcp'],
      ['activity.note', 'ok', localUserId, 'mcp'],
      ['handoff.create', 'ok', localUserId, 'mcp'],
      ['away.set', 'ok', localUserId, 'mcp'],
    ]);
    const issueAudit = await ctx.prisma.auditRecord.findFirst({
      where: { action: 'issue.create', projectId },
      orderBy: { seq: 'asc' },
    });
    expect(issueAudit?.actorRunnerId).toBe(runnerId);
  });

  it('pushes away mode to the runner in `config`', async () => {
    expect((await ask('away.set', { on: true }, null)).ok).toBe(true);
    const config = await socket.next('config');
    expect(config.config.awayMode).toBe(true);
    const update = await ctx.prisma.auditRecord.findFirst({
      where: { action: 'runner.update', targetId: runnerId },
      orderBy: { seq: 'desc' },
    });
    expect(update).toMatchObject({
      actorType: 'runner',
      actorRunnerId: runnerId,
      before: { awayMode: false },
      after: { awayMode: true },
    });
  });

  it('refuses a project this runner does not watch, a viewer write, and a runner without a local user', async () => {
    expect(
      (await ask('fleet.status', {}, otherRunnerProject)).error?.code,
    ).toBe('no_project');
    expect((await ask('fleet.status', {}, null)).error?.code).toBe(
      'no_project',
    );

    await ctx.prisma.projectMember.update({
      where: { projectId_userId: { projectId, userId: localUserId } },
      data: { roleOverride: 'viewer' },
    });
    expect((await ask('fleet.status', {})).ok).toBe(true);
    expect((await ask('issue.create', ARGS['issue.create'])).error?.code).toBe(
      'forbidden',
    );
    expect(commands).toEqual([]);

    await admin.send('patch', `/admin/runners/${runnerId}`, {
      localUserId: null,
    });
    expect((await ask('fleet.status', {})).error?.code).toBe('forbidden');

    const denied = await ctx.prisma.auditRecord.findMany({
      where: { action: 'local.request', actorRunnerId: runnerId },
      orderBy: { seq: 'asc' },
    });
    expect(
      denied.map((d) => [
        (d.after as { method: string }).method,
        d.result,
        (d.meta as { reason: string }).reason,
      ]),
    ).toEqual([
      ['fleet.status', 'denied', 'no_project'],
      ['fleet.status', 'denied', 'no_project'],
      ['issue.create', 'denied', 'forbidden'],
      ['fleet.status', 'denied', 'forbidden'],
    ]);
  });

  it('answers an unknown method and extra args with typed errors', async () => {
    expect((await ask('shell.exec', { cmd: 'id' })).error?.code).toBe(
      'unknown_method',
    );
    expect((await ask('queue.list', { limit: 5, all: true })).error?.code).toBe(
      'invalid_args',
    );
  });
});
