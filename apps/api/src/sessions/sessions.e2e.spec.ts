import type {
  SessionDetail,
  SessionListResponse,
  SessionTotals,
  SessionTreeNode,
} from '@agentdock/shared';
import type { RunnerEvent } from '@agentdock/shared/protocol';
import { Logger } from '@nestjs/common';
import { RunnerEventSinks } from '../runners/runner-event-sinks';
import {
  adminSession,
  CapturingLogger,
  createRunnerE2eApp,
  hello,
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

const T0 = Date.parse('2026-10-07T18:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const tokens = (input: number, output: number, extra = {}) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  reasoning: 0,
  ...extra,
});

/** Builds wire events with consecutive seqs. */
class Events {
  private seq = 0;
  constructor(private readonly runtime = 'claude') {}

  next(
    type: string,
    sessionId: string,
    data: unknown,
    ts: string,
  ): RunnerEvent {
    this.seq += 1;
    return {
      v: 1,
      seq: this.seq,
      ts,
      type,
      source: 'transcript',
      session: { runtime: this.runtime, id: sessionId },
      data,
    };
  }

  get last(): number {
    return this.seq;
  }
}

describe('sessions (e2e)', () => {
  let ctx: RunnerE2eContext;
  let admin: Session;
  const sockets: TestRunnerSocket[] = [];
  let sinkDown = false;

  const open = (token: string) => {
    const socket = new TestRunnerSocket(ctx.origin, token);
    sockets.push(socket);
    return socket;
  };

  const project = (runnerId: string, name: string) =>
    ctx.prisma.project.create({
      data: {
        runnerId,
        rootPath: `/srv/dev/${name}`,
        repo: `acme/${name}`,
        displayName: name,
        baseBranch: 'develop',
        baseSource: 'config',
        hasClaudeMd: true,
        hasAgentsMd: false,
        lastInspectedAt: new Date(),
      },
    });

  /** A paired runner with an open socket, and a helper that sends a batch and awaits its ack. */
  const runner = async () => {
    const { runnerId, token } = await pairedRunner(ctx, admin);
    const socket = open(token);
    await socket.connect();
    const send = async (events: RunnerEvent[]) => {
      socket.send({ type: 'events', events });
      const ack = await socket.next('ack');
      expect(ack.seq).toBe(events.at(-1)?.seq);
    };
    return { runnerId, token, socket, send };
  };

  const member = async (projectId: string, email: string) => {
    const user = await createUser(ctx.prisma, email, 'viewer');
    await ctx.prisma.projectMember.create({
      data: { projectId, userId: user.id },
    });
    return login(ctx, email);
  };

  const list = async (caller: Session, query = '') => {
    const response = await caller.get(`/sessions${query}`);
    return { status: response.status, body: response.body };
  };

  beforeAll(async () => {
    ctx = await createRunnerE2eApp({}, new CapturingLogger());
    ctx.app.get(RunnerEventSinks).register({
      name: 'outage',
      handle: async () => {
        if (sinkDown) throw new Error('database down');
      },
    });
  });
  afterAll(() => ctx.app.close());
  beforeEach(async () => {
    sinkDown = false;
    await resetDatabase(ctx.prisma);
    admin = await adminSession(ctx);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const socket of sockets.splice(0)) socket.socket.terminate();
  });

  /** A session with two turns, a deduped request, a tool call and a subagent. */
  const fullSession = (e: Events, projectId: string) => [
    e.next(
      'session.observed',
      'main-1',
      {
        cwd: '/srv/dev/.wt-widget-i42',
        gitBranch: 'feat/42',
        startedAt: at(0),
        parsed: true,
        projectId,
        slot: 'i42',
        profileKey: 'claude-default',
      },
      at(0),
    ),
    e.next('turn.started', 'main-1', { promptId: 'p1' }, at(0)),
    e.next(
      'llm.request',
      'main-1',
      {
        requestId: 'req_a',
        promptId: 'p1',
        model: 'claude-opus-5-5',
        tokens: tokens(10, 5),
        querySource: 'main',
      },
      at(1),
    ),
    // D4: the same requestId again, the last usage wins.
    e.next(
      'llm.request',
      'main-1',
      {
        requestId: 'req_a',
        promptId: 'p1',
        model: 'claude-opus-5-5',
        tokens: tokens(10, 20, { cacheRead: 100, reasoning: 7 }),
        querySource: 'main',
        stopReason: 'tool_use',
      },
      at(2),
    ),
    e.next(
      'tool.call',
      'main-1',
      {
        toolUseId: 'tu_task',
        promptId: 'p1',
        tool: 'Task',
        startedAt: at(3),
      },
      at(3),
    ),
    e.next(
      'session.observed',
      'agent-1',
      {
        cwd: '/srv/dev/.wt-widget-i42',
        startedAt: at(3),
        parsed: true,
        parent: { sessionId: 'main-1', toolUseId: 'tu_task' },
      },
      at(3),
    ),
    e.next(
      'llm.request',
      'agent-1',
      {
        requestId: 'req_sub',
        model: 'claude-haiku-5-5',
        tokens: tokens(3, 4, { cacheWrite5m: 9, cacheWrite1h: 2 }),
        querySource: 'subagent',
      },
      at(4),
    ),
    e.next(
      'tool.call',
      'main-1',
      {
        toolUseId: 'tu_task',
        promptId: 'p1',
        tool: 'Task',
        startedAt: at(3),
        endedAt: at(5),
        ok: true,
        childSessionId: 'agent-1',
      },
      at(5),
    ),
    e.next('turn.finished', 'main-1', { promptId: 'p1' }, at(5)),
    e.next('turn.started', 'main-1', { promptId: 'p2' }, at(6)),
    e.next(
      'llm.request',
      'main-1',
      {
        requestId: 'req_b',
        promptId: 'p2',
        model: 'claude-sonnet-5-5',
        tokens: tokens(1, 1),
        querySource: 'main',
      },
      at(7),
    ),
  ];

  const sum = (nodes: { totals: SessionTotals }[]): number[] => {
    const keys = [
      'input',
      'output',
      'cacheRead',
      'cacheWrite5m',
      'cacheWrite1h',
      'reasoning',
      'requests',
    ] as const;
    return keys.map((k) => nodes.reduce((n, node) => n + node.totals[k], 0));
  };
  const values = (t: SessionTotals) => [
    t.input,
    t.output,
    t.cacheRead,
    t.cacheWrite5m,
    t.cacheWrite1h,
    t.reasoning,
    t.requests,
  ];

  /** Asserts every node's totals are the sum of its children's, recursively. */
  const expectSums = (node: SessionTreeNode): void => {
    for (const turn of node.turns) {
      expect(values(turn.totals)).toEqual(
        sum([...turn.requests, ...turn.tools]),
      );
      for (const tool of turn.tools) {
        if (tool.child) {
          expect(values(tool.totals)).toEqual(values(tool.child.totals));
          expectSums(tool.child);
        }
      }
    }
    expect(values(node.totals)).toEqual(
      sum([
        ...node.turns,
        ...node.unattributed.requests,
        ...node.unattributed.tools,
        ...node.subagents,
      ]),
    );
    expect(values(node.session.totals)).toEqual(values(node.totals));
    node.subagents.forEach(expectSums);
  };

  describe('ingest and tree', () => {
    it('builds the tree, dedupes requests, links the subagent, and totals add up', async () => {
      const r = await runner();
      const widget = await project(r.runnerId, 'widget');
      await r.send(fullSession(new Events(), widget.id));

      const { status, body } = await list(admin);
      expect(status).toBe(200);
      const page = body as SessionListResponse;
      expect(page.items).toHaveLength(1);
      const [summary] = page.items;
      expect(summary).toMatchObject({
        externalId: 'main-1',
        projectId: widget.id,
        projectName: 'widget',
        slotName: 'i42',
        gitBranch: 'feat/42',
        profileKey: 'claude-default',
        models: ['claude-opus-5-5', 'claude-sonnet-5-5'],
        turns: 2,
        toolCalls: 1,
        subagents: 1,
        totals: {
          input: 14,
          output: 25,
          cacheRead: 100,
          cacheWrite5m: 9,
          cacheWrite1h: 2,
          reasoning: 7,
          requests: 3,
          costUsd: null,
        },
      });

      const detail = (await admin.get(`/sessions/${summary.id}`))
        .body as SessionDetail;
      expect(detail.turns.map((t) => t.promptId)).toEqual(['p1', 'p2']);
      expect(detail.turns[0].endedAt).toBe(at(5));
      expect(detail.turns[0].requests).toHaveLength(1);
      expect(detail.turns[0].requests[0]).toMatchObject({
        requestId: 'req_a',
        stopReason: 'tool_use',
        totals: { input: 10, output: 20, cacheRead: 100, reasoning: 7 },
      });
      const [task] = detail.turns[0].tools;
      expect(task).toMatchObject({ name: 'Task', ok: true, endedAt: at(5) });
      expect(task.child?.session).toMatchObject({
        externalId: 'agent-1',
        parentSessionId: summary.id,
        projectId: widget.id,
        slotName: 'i42',
      });
      expect(detail.subagents).toEqual([]);
      expect(values(detail.totals)).toEqual(values(summary.totals));
      expectSums(detail);
    });

    it('applies a resent batch once', async () => {
      const r = await runner();
      const widget = await project(r.runnerId, 'widget');
      const batch = fullSession(new Events(), widget.id);
      await r.send(batch);
      r.socket.socket.terminate();
      await r.socket.closed;

      const again = open(r.token);
      await again.connect(hello({ lastAckedSeq: 0 }));
      again.send({ type: 'events', events: batch });
      await again.next('ack');

      expect(await ctx.prisma.agentSession.count()).toBe(2);
      expect(await ctx.prisma.llmRequest.count()).toBe(3);
      expect(await ctx.prisma.turn.count()).toBe(2);
      expect(await ctx.prisma.toolCall.count()).toBe(1);
    });

    it('links a child that is seen before its parent', async () => {
      const r = await runner();
      const widget = await project(r.runnerId, 'widget');
      const e = new Events();
      await r.send([
        e.next(
          'llm.request',
          'agent-x',
          {
            requestId: 'req_1',
            model: 'claude-haiku-5-5',
            tokens: tokens(1, 2),
            querySource: 'subagent',
          },
          at(1),
        ),
        e.next(
          'tool.call',
          'main-x',
          {
            toolUseId: 'tu_1',
            tool: 'Task',
            startedAt: at(0),
            childSessionId: 'agent-x',
          },
          at(0),
        ),
        e.next(
          'session.observed',
          'main-x',
          {
            cwd: '/srv/dev/widget',
            startedAt: at(0),
            parsed: true,
            projectId: widget.id,
          },
          at(2),
        ),
      ]);
      const page = (await list(admin)).body as SessionListResponse;
      expect(page.items.map((s) => s.externalId)).toEqual(['main-x']);
      const detail = (await admin.get(`/sessions/${page.items[0].id}`))
        .body as SessionDetail;
      const tool = detail.unattributed.tools[0];
      expect(tool.child?.session).toMatchObject({
        externalId: 'agent-x',
        projectId: widget.id,
      });
      expect(detail.totals.requests).toBe(1);
      expectSums(detail);
    });

    it('stores a project the runner does not own as no project', async () => {
      const r = await runner();
      const other = await runner();
      const foreign = await project(other.runnerId, 'foreign');
      const e = new Events();
      await r.send([
        e.next(
          'session.observed',
          's-1',
          {
            cwd: '/srv/dev/foreign',
            startedAt: at(0),
            parsed: true,
            projectId: foreign.id,
            slot: 'i1',
          },
          at(0),
        ),
      ]);
      const row = await ctx.prisma.agentSession.findFirstOrThrow();
      expect(row).toMatchObject({ projectId: null, slotName: null });
    });

    it('skips malformed events and stores the rest of the batch', async () => {
      const r = await runner();
      const e = new Events();
      const missingData = e.next(
        'llm.request',
        's-1',
        { requestId: 'r1' },
        at(0),
      );
      const valid = e.next(
        'llm.request',
        's-1',
        {
          requestId: 'r2',
          model: 'm',
          tokens: tokens(1, 1),
          querySource: 'main',
        },
        at(1),
      );
      const noSession = {
        ...e.next('turn.started', 's-1', { promptId: 'p' }, at(1)),
        session: undefined,
      };
      const unknownRuntime = {
        ...e.next('turn.started', 's-2', { promptId: 'p' }, at(1)),
        session: { runtime: 'gemini', id: 's-2' },
      };
      await r.send([missingData, valid, noSession, unknownRuntime]);
      expect(
        (await ctx.prisma.llmRequest.findMany()).map((x) => x.requestId),
      ).toEqual(['r2']);
      expect(await ctx.prisma.turn.count()).toBe(0);
      expect(await ctx.prisma.event.count()).toBe(4);
    });

    it('closes 1011 and stores nothing when a sink fails; the resend stores', async () => {
      const r = await runner();
      const e = new Events();
      const first = [e.next('turn.started', 's-1', { promptId: 'p1' }, at(0))];
      await r.send(first);

      sinkDown = true;
      const second = [e.next('turn.started', 's-1', { promptId: 'p2' }, at(1))];
      r.socket.send({ type: 'events', events: second });
      expect((await r.socket.closed).code).toBe(1011);
      expect(await ctx.prisma.event.count()).toBe(1);
      const { ackedSeq } = await ctx.prisma.runner.findUniqueOrThrow({
        where: { id: r.runnerId },
      });
      expect(ackedSeq).toBe(1n);

      sinkDown = false;
      const again = open(r.token);
      expect((await again.connect(hello({ lastAckedSeq: 1 }))).ackedSeq).toBe(
        1,
      );
      again.send({ type: 'events', events: second });
      expect(await again.next('ack')).toEqual({ type: 'ack', seq: 2 });
      expect(await ctx.prisma.event.count()).toBe(2);
      expect(await ctx.prisma.turn.count()).toBe(2);
    });
  });

  describe('authorization', () => {
    const seed = async () => {
      const r = await runner();
      const a = await project(r.runnerId, 'alpha');
      const b = await project(r.runnerId, 'beta');
      const e = new Events();
      const observed = (id: string, projectId?: string) =>
        e.next(
          'session.observed',
          id,
          {
            cwd: '/srv/dev/x',
            startedAt: at(0),
            parsed: true,
            ...(projectId ? { projectId } : {}),
          },
          at(0),
        );
      await r.send([
        observed('in-a', a.id),
        observed('in-b', b.id),
        observed('nowhere'),
      ]);
      const byExternal = async (externalId: string) =>
        (
          await ctx.prisma.agentSession.findFirstOrThrow({
            where: { externalId },
          })
        ).id;
      return {
        a,
        b,
        ids: {
          a: await byExternal('in-a'),
          b: await byExternal('in-b'),
          none: await byExternal('nowhere'),
        },
      };
    };

    it('a member of A sees only A, in the list and by id', async () => {
      const { a, b, ids } = await seed();
      const alice = await member(a.id, 'alice@example.com');

      const page = (await list(alice)).body as SessionListResponse;
      expect(page.items.map((s) => s.externalId)).toEqual(['in-a']);
      expect((await alice.get(`/sessions/${ids.a}`)).status).toBe(200);
      expect((await alice.get(`/sessions/${ids.b}`)).status).toBe(404);
      expect((await alice.get(`/sessions/${ids.none}`)).status).toBe(404);
      expect((await list(alice, `?projectId=${b.id}`)).status).toBe(404);
      expect((await list(alice, `?projectId=${a.id}`)).status).toBe(200);
    });

    it('a non-admin never sees unassigned sessions, even with unassigned=true', async () => {
      const { a } = await seed();
      const alice = await member(a.id, 'alice@example.com');
      const response = await list(alice, '?unassigned=true');
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ error: 'forbidden' });
    });

    it('an admin sees connected projects by default and unassigned on request', async () => {
      await seed();
      const all = (await list(admin)).body as SessionListResponse;
      expect(all.items.map((s) => s.externalId).sort()).toEqual([
        'in-a',
        'in-b',
      ]);
      const unassigned = (await list(admin, '?unassigned=true'))
        .body as SessionListResponse;
      expect(unassigned.items.map((s) => s.externalId)).toEqual(['nowhere']);
    });

    it('anonymous gets 401', async () => {
      const { ids } = await seed();
      expect((await ctx.http().get('/sessions')).status).toBe(401);
      expect((await ctx.http().get(`/sessions/${ids.a}`)).status).toBe(401);
    });

    it('rejects unknown query fields and contradictory filters', async () => {
      const { a } = await seed();
      expect((await list(admin, '?foo=1')).status).toBe(400);
      expect(
        (await list(admin, `?unassigned=true&projectId=${a.id}`)).status,
      ).toBe(400);
    });
  });

  describe('list filters and paging', () => {
    it('filters by runtime, model, slot and date, and pages by cursor', async () => {
      const r = await runner();
      const widget = await project(r.runnerId, 'widget');
      const claude = new Events();
      const batch: RunnerEvent[] = [];
      for (let i = 0; i < 3; i += 1) {
        batch.push(
          claude.next(
            'session.observed',
            `s-${i}`,
            {
              cwd: '/srv/dev/widget',
              startedAt: at(i * 60),
              parsed: true,
              projectId: widget.id,
              slot: i === 0 ? 'i1' : 'i2',
            },
            at(i * 60),
          ),
          claude.next(
            'llm.request',
            `s-${i}`,
            {
              requestId: 'r',
              model: i === 2 ? 'claude-haiku-5-5' : 'claude-opus-5-5',
              tokens: tokens(1, 1),
              querySource: 'main',
            },
            at(i * 60 + 1),
          ),
        );
      }
      await r.send(batch);

      const ids = async (query: string) =>
        ((await list(admin, query)).body as SessionListResponse).items.map(
          (s) => s.externalId,
        );
      expect(await ids('')).toEqual(['s-2', 's-1', 's-0']);
      expect(await ids('?model=claude-haiku-5-5')).toEqual(['s-2']);
      expect(await ids('?slot=i1')).toEqual(['s-0']);
      expect(await ids('?runtime=codex')).toEqual([]);
      expect(await ids(`?from=${at(60)}&to=${at(120)}`)).toEqual(['s-1']);

      const first = (await list(admin, '?limit=2')).body as SessionListResponse;
      expect(first.items.map((s) => s.externalId)).toEqual(['s-2', 's-1']);
      expect(first.nextCursor).not.toBeNull();
      const second = (await list(admin, `?limit=2&cursor=${first.nextCursor}`))
        .body as SessionListResponse;
      expect(second.items.map((s) => s.externalId)).toEqual(['s-0']);
      expect(second.nextCursor).toBeNull();
    });
  });
});
