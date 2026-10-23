import {
  type LocalMethodName,
  type LocalResponseMessage,
  localMethodNames,
  localMethods,
  MANUAL_HANDOFF_EVENT,
  MANUAL_NOTE_EVENT,
} from '@nautelle/shared/protocol';
import { seedProject } from '../fleet/testing/fleet-e2e';
import {
  adminSession,
  capabilities,
  createRunnerE2eApp,
  pairedRunner,
  type RunnerE2eContext,
  TestRunnerSocket,
} from '../runners/testing/runner-e2e';
import { createUser, resetDatabase, type Session } from '../test/e2e-app';

const ROOT = '/srv/dev/widget';
const OTHER_ROOT = '/srv/dev/gadget';
const ISSUE_URL = 'https://github.com/acme/widget/issues';
/** A board card worker's Claude session (issue #242 D6). */
const CARD_SESSION = '0b7e7c1e-5d0f-4c1a-9a51-2f3c4d5e6f70';
/** #884: a review step's Claude session on that card's pull request. */
const REVIEW_SESSION = '7d0c2a4e-9b1f-4e3a-8c5d-6f7a8b9c0d1e';

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
  'card.finish': { summary: 'Done.' },
  'card.escalate': {
    reason: 'misclassified',
    note: 'The card needs a schema decision.',
  },
  'card.reviewReport': {
    findings: [
      {
        severity: 'nit',
        file: 'src/pairing.ts',
        line: 3,
        title: 'Name the timeout',
        body: 'A named constant reads better.',
      },
    ],
    summary: 'One nit.',
  },
  'card.track': { title: 'Track the pairing fix' },
  'board.list': {},
  'board.card': { card: 1 },
  'board.wait': { timeoutSec: 0 },
  // #845: C-1 is Finished by now, C-2 the session's tracked card, C-3 new.
  'card.create': { title: 'Retry the pairing handshake' },
  'card.run': { card: 1 },
  'card.move': { card: 3, column: 'todo', index: 0 },
  'card.feedback': { card: 1, text: 'Handle the macOS case too.' },
  'card.message': { card: 1, kind: 'text', text: 'Use the existing helper.' },
  'card.stop': { card: 1 },
  // The session holds C-2, so C-3 is queued for it — and released.
  'card.take': { card: 3 },
  'card.release': { card: 3 },
};

/**
 * #845: the Board's control methods, in the order the sweep calls them —
 * feedback on the Finished C-1 starts a round the message reaches and Stop
 * ends, then a Run starts the next.
 */
const BOARD_CONTROL_ORDER: readonly LocalMethodName[] = [
  'card.create',
  'card.move',
  'card.feedback',
  'card.message',
  'card.stop',
  'card.run',
  'card.take',
  'card.release',
];

/** What the runner answers the card commands the Board methods send. */
const CARD_COMMAND_OUTPUTS: Record<
  string,
  ((args: Record<string, unknown>) => unknown) | undefined
> = {
  'card.run': (args) => ({
    phase: 'starting',
    tmuxSession: `nautelle-card-${String(args.shortId)}`,
  }),
  'card.stop': () => ({ stopped: true }),
  'session.message': () => ({ outcome: 'sent' }),
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
    sessionId = 'sess-manual-1',
  ): Promise<LocalResponseMessage> => {
    nextId += 1;
    const id = `lr_${nextId}`;
    socket.send({
      type: 'local.request',
      id,
      method,
      args,
      ...(project ? { projectId: project } : {}),
      session: { runtime: 'claude', id: sessionId },
      via: 'mcp',
    });
    for (;;) {
      const response = await socket.next('local.response', 10_000);
      if (response.id === id) return response;
    }
  };

  /** Polls `condition` until it holds; fails after `timeoutMs`. */
  const waitFor = async (condition: () => boolean, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('waitFor timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  /**
   * Answers `issue.create` like the runner's handler, numbering from 100, and
   * `plan.queue_issues` by labelling every issue it names.
   */
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
      // #845: a card worker's launch, stop and session message.
      const card = CARD_COMMAND_OUTPUTS[command.name];
      if (card) {
        socket.send({
          type: 'command.result',
          id: command.id,
          ok: true,
          output: card(args),
        });
        continue;
      }
      if (command.name === 'plan.queue_issues') {
        socket.send({
          type: 'command.result',
          id: command.id,
          ok: true,
          output: { labelled: args.numbers },
        });
        continue;
      }
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

  /**
   * Card C-1 of the project, its worker running in `CARD_SESSION`. #750: on
   * the person's `sonnet` in the B arm of `model-by-type`, so `card.escalate`
   * is answered and relaunches nothing (D10); `arm: 'a'` refuses it.
   */
  const seedCardSession = async (arm: 'a' | 'b' = 'b') => {
    const now = new Date();
    const run = await ctx.prisma.run.create({
      data: {
        kind: 'card',
        projectId,
        status: 'running',
        model: 'sonnet',
        triggeredByType: 'user',
        startedAt: now,
        updatedAt: now,
      },
    });
    await ctx.prisma.boardCard.create({
      data: {
        projectId,
        number: 1,
        shortId: 'abcd1234',
        title: 'Add login',
        column: 'in_progress',
        position: 0,
        issueOnRun: false,
        specOnRun: false,
        sessionId: CARD_SESSION,
        branch: 'card/c1-add-login',
        model: 'sonnet',
        techniqueArms: {
          create: { technique: 'model-by-type', arm, mode: 'ab' },
        },
        movedAt: now,
        rounds: {
          create: {
            round: 1,
            runId: run.id,
            trigger: 'run',
            phase: 'running',
            cardTitle: 'Add login',
            cardBody: '',
            cardKind: 'feature',
          },
        },
      },
    });
  };

  /** The sweep's own session `sess-manual-1`, as its hooks made it: manual. */
  /** #884: a running review step of C-1, started for `REVIEW_SESSION`. */
  const seedReviewSession = async () => {
    const card = await ctx.prisma.boardCard.findFirstOrThrow({
      where: { projectId, number: 1 },
    });
    const run = await ctx.prisma.run.create({
      data: {
        kind: 'card_review',
        projectId,
        status: 'running',
        model: 'sonnet',
        triggeredByType: 'user',
        startedAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await ctx.prisma.boardCardReviewRun.create({
      data: {
        cardId: card.id,
        stepName: 'Peer review',
        stepType: 'peer_review',
        position: 0,
        prNumber: 7,
        headSha: 'a'.repeat(40),
        pass: 0,
        runId: run.id,
        sessionId: REVIEW_SESSION,
        startedAt: new Date(),
      },
    });
  };

  const seedManualSession = () =>
    ctx.prisma.agentSession.create({
      data: {
        runnerId,
        runtime: 'claude',
        externalId: 'sess-manual-1',
        projectId,
        cwd: ROOT,
        origin: 'manual',
        ownerId: localUserId,
        startedAt: new Date(),
        lastEventAt: new Date(),
      },
    });

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
    // `card.finish` asks from the session of a board card's running worker.
    await seedCardSession();
    // #884: `card.reviewReport` asks from a review step's session.
    await seedReviewSession();
    // `card.track` asks from a person's own session (#282 D1).
    const manual = await seedManualSession();
    // #845: the Board's control methods launch a worker and message it — the
    // runner's Claude profile, and a runner that takes session messages.
    const profile = await ctx.prisma.runtimeProfile.findFirstOrThrow({
      where: { runnerId, key: 'claude-main' },
    });
    await ctx.prisma.project.update({
      where: { id: projectId },
      data: { defaultProfileId: profile.id },
    });
    await ctx.prisma.runner.update({
      where: { id: runnerId },
      data: { capabilities: { ...capabilities, sessionMessage: true } },
    });
    // `action.request` first: `action.status` asks about the request it made.
    // #750: `card.escalate` just before `card.finish` — it needs the active
    // round, and its `card.stop` takes the place `card.finish`'s had.
    // #845: the Board's control methods last, in their own order.
    const order = [
      'action.request',
      ...localMethodNames
        .filter(
          (m) =>
            m !== 'action.request' &&
            m !== 'card.escalate' &&
            !BOARD_CONTROL_ORDER.includes(m),
        )
        .flatMap((m) =>
          m === 'card.finish' ? (['card.escalate', m] as const) : [m],
        ),
      ...BOARD_CONTROL_ORDER,
    ] as LocalMethodName[];
    for (const method of order) {
      const args = method === 'action.status' ? { id: actionId } : ARGS[method];
      const response = await ask(
        method,
        args,
        localMethods[method].needsProject ? projectId : null,
        method === 'card.finish' || method === 'card.escalate'
          ? CARD_SESSION
          : method === 'card.reviewReport'
            ? REVIEW_SESSION
            : undefined,
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
    expect(context.text).toContain(
      "This session's issue: #12 (open). Issue title (untrusted): «Pairing fails on macOS».",
    );
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
    expect(responses.get('card.finish')?.data).toEqual({
      number: 1,
      finished: true,
    });
    expect(responses.get('card.reviewReport')?.data).toEqual({
      number: 1,
      recorded: true,
      blocking: 0,
      nits: 1,
    });
    expect(responses.get('card.track')?.data).toMatchObject({
      number: 2,
      label: 'C-2',
    });

    // The writes acted as the local user, through the runner.
    const issueCreates = commands.filter((c) => c.name === 'issue.create');
    // C-112: the handoff is filed unqueued; a person queues it.
    expect(issueCreates.map((c) => c.args.queue)).toEqual([false, false]);
    expect(responses.get('handoff.create')?.data).toMatchObject({
      number: 102,
      queued: false,
      actionRequestId: expect.any(String),
      waiting: expect.stringContaining('waits for a person'),
    });
    expect(responses.get('issue.create')?.data).toEqual({
      number: 101,
      url: `${ISSUE_URL}/101`,
      queued: false,
    });
    const handoffBody = issueCreates[1].args.body as string;
    expect(handoffBody).toContain('## Acceptance criteria');
    expect(handoffBody).toContain('Source branch: `fix/12-pairing`');
    expect(handoffBody).toContain(
      'Continue from branch `fix/12-pairing` if it exists.',
    );

    // `card.finish` fires `card.collect` asynchronously: wait for it, then
    // expect exactly one for the finished card.
    await waitFor(() => commands.some((c) => c.name === 'card.collect'));
    expect(commands.filter((c) => c.name === 'card.collect')).toHaveLength(1);

    const events = await ctx.prisma.event.findMany({
      where: { type: { in: [MANUAL_NOTE_EVENT, MANUAL_HANDOFF_EVENT] } },
      orderBy: { id: 'asc' },
    });
    expect(events.map((e) => [e.type, e.source, e.data])).toEqual([
      [
        MANUAL_NOTE_EVENT,
        'api',
        { text: 'Investigating the pairing flake', sessionId: manual.id },
      ],
      [
        MANUAL_HANDOFF_EVENT,
        'api',
        { issue: 102, branch: 'fix/12-pairing', sessionId: manual.id },
      ],
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
      ['card.escalate', 'ok', localUserId, 'mcp'],
      ['card.finish', 'ok', localUserId, 'mcp'],
      ['card.reviewReport', 'ok', localUserId, 'mcp'],
      ['card.track', 'ok', localUserId, 'mcp'],
      ['away.set', 'ok', localUserId, 'mcp'],
      ...BOARD_CONTROL_ORDER.map((method) => [
        method,
        'ok',
        localUserId,
        'mcp',
      ]),
    ]);

    // #845: the take queued C-3 behind the tracked C-2; the release cleared it.
    expect(responses.get('card.take')?.data).toMatchObject({
      number: 3,
      state: 'queued',
      queuePosition: 1,
    });
    expect(responses.get('card.release')?.data).toEqual({
      number: 3,
      column: 'todo',
      next: null,
    });
    const issueAudit = await ctx.prisma.auditRecord.findFirst({
      where: { action: 'issue.create', projectId },
      orderBy: { seq: 'asc' },
    });
    expect(issueAudit?.actorRunnerId).toBe(runnerId);
  });

  describe('a session never queues an issue itself (C-112)', () => {
    const HANDOFF = ARGS['handoff.create'] as { title: string };

    const pendingIssueQueue = () =>
      ctx.prisma.actionRequest.findMany({
        where: { projectId, kind: 'issue_queue' },
      });

    const decide = (id: string, decision: 'approve' | 'deny') =>
      admin.send(
        'post',
        `/projects/${projectId}/action-requests/${id}/${decision}`,
        {},
      );

    it('files a handoff without the ready label, with a pending issue_queue request, and names whom it acted for', async () => {
      const manual = await seedManualSession();
      const response = await ask('handoff.create', ARGS['handoff.create']);
      expect(response.ok).toBe(true);
      expect(response.data).toMatchObject({
        number: 101,
        queued: false,
        waiting: expect.stringContaining('Issue #101 is not queued yet'),
      });

      const created = commands.filter((c) => c.name === 'issue.create');
      expect(created.map((c) => c.args.queue)).toEqual([false]);
      const [request] = await pendingIssueQueue();
      expect(request).toMatchObject({
        id: (response.data as { actionRequestId: string }).actionRequestId,
        status: 'pending',
        sessionId: manual.id,
        requestedById: localUserId,
        args: {
          issue: 101,
          title: HANDOFF.title,
          url: `${ISSUE_URL}/101`,
          session: manual.id,
        },
      });

      const audit = await ctx.prisma.auditRecord.findFirstOrThrow({
        where: { action: 'issue.create', projectId },
      });
      expect(audit.actorRunnerId).toBe(runnerId);
      expect(audit.after).toMatchObject({ queue: true, held: true });
      expect(audit.meta).toMatchObject({
        via: 'mcp',
        onBehalfOf: {
          userId: localUserId,
          runnerId,
          sessionId: manual.id,
        },
      });
    });

    it('adds the ready label when a person approves, through the queue as the approver', async () => {
      const response = await ask('handoff.create', ARGS['handoff.create']);
      const { actionRequestId } = response.data as { actionRequestId: string };
      expect(commands.some((c) => c.name === 'plan.queue_issues')).toBe(false);

      const approved = await decide(actionRequestId, 'approve');
      expect(approved.status).toBe(200);
      expect(approved.body).toMatchObject({
        status: 'executed',
        result: { issue: 101 },
      });
      expect(
        commands
          .filter((c) => c.name === 'plan.queue_issues')
          .map((c) => c.args),
      ).toEqual([{ projectId, numbers: [101], readyLabel: 'cs:ready' }]);
      const queued = await ctx.prisma.auditRecord.findFirstOrThrow({
        where: { action: 'issue.queue', projectId },
      });
      expect(queued.result).toBe('ok');
      expect(queued.actorUserId).not.toBeNull();
      expect(queued.meta).toMatchObject({ actionRequestId, via: 'web' });
    });

    it('leaves the issue unqueued when a person denies, and sends nothing', async () => {
      const response = await ask('handoff.create', ARGS['handoff.create']);
      const { actionRequestId } = response.data as { actionRequestId: string };
      const before = commands.length;

      const denied = await decide(actionRequestId, 'deny');
      expect(denied.status).toBe(200);
      expect(denied.body).toMatchObject({ status: 'denied' });
      expect(commands.slice(before)).toEqual([]);
      expect(
        await ctx.prisma.auditRecord.count({
          where: { action: 'issue.queue', projectId },
        }),
      ).toBe(0);
    });

    it('holds issue.create with queue: true the same way, and asks nothing with queue: false', async () => {
      const plain = await ask('issue.create', ARGS['issue.create']);
      expect(plain.data).toEqual({
        number: 101,
        url: `${ISSUE_URL}/101`,
        queued: false,
      });
      expect(await pendingIssueQueue()).toEqual([]);

      const asked = await ask('issue.create', {
        ...(ARGS['issue.create'] as object),
        queue: true,
        body: 'Seen twice.\n\n## Acceptance criteria\n\n- [ ] it passes',
      });
      expect(asked.data).toMatchObject({ number: 102, queued: false });
      expect(
        commands
          .filter((c) => c.name === 'issue.create')
          .map((c) => c.args.queue),
      ).toEqual([false, false]);
      expect(await pendingIssueQueue()).toHaveLength(1);
    });

    it('still refuses an incomplete issue a session asks to queue, and asks nothing', async () => {
      const refused = await ask('issue.create', {
        ...(ARGS['issue.create'] as object),
        queue: true,
      });
      expect(refused.ok).toBe(false);
      expect(commands.filter((c) => c.name === 'issue.create')).toEqual([]);
      expect(await pendingIssueQueue()).toEqual([]);
    });

    it('refuses an issue_queue request a session asks for directly', async () => {
      const refused = await ask('action.request', {
        kind: 'issue_queue',
        args: { issue: 7, title: 'x', url: `${ISSUE_URL}/7`, session: null },
        summary: 'Queue it',
      });
      expect(refused.ok).toBe(false);
      expect(refused.error?.code).toBe('invalid_args');
      expect(await pendingIssueQueue()).toEqual([]);
    });
  });

  it('answers card.finish from a session that is not a card worker with not_a_card_session', async () => {
    await seedCardSession();
    const manual = await ask('card.finish', { summary: 'Done.' });
    expect(manual.error?.code).toBe('not_a_card_session');
    // The card's session, but asked about another project: not this card.
    const elsewhere = await ask(
      'card.finish',
      { summary: 'Done.' },
      otherRunnerProject,
      CARD_SESSION,
    );
    expect(elsewhere.ok).toBe(false);
    const card = await ctx.prisma.boardCard.findFirstOrThrow({
      include: { rounds: true },
    });
    expect(card.column).toBe('in_progress');
    expect(card.rounds[0].phase).toBe('running');
  });

  it('answers card.escalate from a card worker, and keeps a person’s sonnet (#750 D9, D10)', async () => {
    await seedCardSession();
    const response = await ask(
      'card.escalate',
      ARGS['card.escalate'],
      projectId,
      CARD_SESSION,
    );
    expect([response.ok, response.data]).toEqual([
      true,
      { number: 1, escalated: true, relaunched: false },
    ]);
    const card = await ctx.prisma.boardCard.findFirstOrThrow({
      where: { projectId, number: 1 },
      include: { rounds: true },
    });
    expect(card).toMatchObject({
      column: 'finished',
      escalationReason: 'misclassified',
      workClass: 'deciding',
    });
    expect(card.rounds[0]).toMatchObject({
      finishedBy: 'worker',
      escalation: 'misclassified',
    });
  });

  it('refuses card.escalate in the A arm, and from a session that is no card worker (#750)', async () => {
    await seedCardSession('a');
    const refused = await ask(
      'card.escalate',
      ARGS['card.escalate'],
      projectId,
      CARD_SESSION,
    );
    expect([refused.ok, refused.error?.code]).toEqual([
      false,
      'not_escalatable',
    ]);
    await seedManualSession();
    const manual = await ask('card.escalate', ARGS['card.escalate'], projectId);
    expect([manual.ok, manual.error?.code]).toEqual([
      false,
      'not_a_card_session',
    ]);
  });

  it('refuses card.track for a local user who is not a project member, and creates no card (#282 D1)', async () => {
    await seedManualSession();
    await ctx.prisma.projectMember.delete({
      where: { projectId_userId: { projectId, userId: localUserId } },
    });
    const refused = await ask('card.track', ARGS['card.track']);
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe('forbidden');
    expect(await ctx.prisma.boardCard.count()).toBe(0);
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
