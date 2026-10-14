import type {
  FleetGraph,
  FleetSlotNode,
  SlotConversation,
  SlotWorktreeView,
} from '@agentdock/shared';
import type {
  CommandErrorCode,
  RunnerEvent,
  WorktreeStatusResult,
} from '@agentdock/shared/protocol';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../app.module';
import { configureApp } from '../configure-app';
import { PrismaService } from '../database/prisma.service';
import { allowedLiveOrigin } from '../live/live-options';
import { TestLiveSocket } from '../live/testing/live-e2e';
import {
  defaultRunnerOptions,
  RUNNER_OPTIONS,
} from '../runners/runner-options';
import {
  adminSession,
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
import { FLEET_WORKSPACE_OPTIONS } from './fleet-workspace-options';
import { EventStream, ROOT, seedProject } from './testing/fleet-e2e';

const OTHER_ROOT = '/srv/dev/gadget';
const SHA = 'a'.repeat(40);
/** Short enough that the "never answers" case does not slow the suite. */
const TIMEOUT_MS = 400;

const STATUS: WorktreeStatusResult = {
  slot: 'i42',
  branch: 'feat/42-x',
  head: SHA,
  base: 'origin/develop',
  ahead: 2,
  behind: 0,
  changed: 1,
  untracked: 1,
  files: [
    { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 },
    { path: 'notes.md', status: 'untracked', additions: null, deletions: null },
  ],
  filesTruncated: 0,
  commits: [
    {
      sha: SHA,
      subject: 'feat: x',
      author: 'Archi',
      at: '2026-10-14T09:00:00Z',
    },
  ],
};

type Answer =
  | { ok: true; output: unknown }
  | { ok: false; code: CommandErrorCode; message?: string }
  | 'silence';

interface Received {
  name: string;
  args: Record<string, unknown>;
}

/** A connected runner that answers `worktree.status` and records it. */
class FakeRunner {
  readonly received: Received[] = [];
  answer: (command: Received) => Answer = () => ({ ok: true, output: STATUS });

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

  worktree(): Received[] {
    return this.received.filter((r) => r.name === 'worktree.status');
  }
}

const createApp = async (): Promise<RunnerE2eContext> => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(RUNNER_OPTIONS)
    .useValue(defaultRunnerOptions)
    .overrideProvider(FLEET_WORKSPACE_OPTIONS)
    .useValue({ worktreeCacheMs: 10_000, worktreeTimeoutMs: TIMEOUT_MS })
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const origin = (await app.getUrl()).replace(/\/+$/, '');
  process.env.API_URL = origin;
  return {
    app,
    prisma: app.get(PrismaService),
    http: () => request(app.getHttpServer()),
    origin,
  };
};

describe('agent workspace routes (e2e)', () => {
  let ctx: RunnerE2eContext;
  let runnerId: string;
  let token: string;
  let a: string;
  let b: string;
  let member: Session;
  let memberOfB: Session;
  let stream: EventStream;
  const closers: (() => void)[] = [];

  const routes = (projectId: string) => [
    `/projects/${projectId}/fleet/graph`,
    `/projects/${projectId}/slots/i42/conversation`,
    `/projects/${projectId}/slots/i42/worktree`,
  ];

  const viewerOf = async (email: string, projectId: string) => {
    const user = await createUser(ctx.prisma, email, 'viewer');
    await ctx.prisma.projectMember.create({
      data: { projectId, userId: user.id },
    });
    return login(ctx, email);
  };

  const runner = async () => {
    const socket = new TestRunnerSocket(ctx.origin, token);
    closers.push(() => socket.socket.terminate());
    await socket.connect(hello());
    return socket;
  };

  /** Sends a batch through the runner socket: stored in `events` and projected. */
  const send = async (socket: TestRunnerSocket, events: RunnerEvent[]) => {
    socket.send({ type: 'events', events });
    const ack = await socket.next('ack');
    expect(ack.seq).toBe(events.at(-1)?.seq);
  };

  const dispatch = (slot: string, issue: number, extra: object = {}) =>
    stream.next(
      'slot.dispatched',
      {
        date: '2026-10-14',
        round: '0900',
        model: 'opus',
        branch: `feat/${slot}`,
        ...extra,
      },
      { slot, issue, source: 'scraped' },
    );

  const issue = (number: number, title: string, body: string) =>
    ctx.prisma.issueCache.create({
      data: {
        projectId: a,
        number,
        title,
        state: 'open',
        labels: [],
        assignees: [],
        body,
        url: `https://github.com/acme/widget/issues/${number}`,
        ghUpdatedAt: new Date('2026-10-14T08:00:00Z'),
        snapshotAt: new Date('2026-10-14T08:00:00Z'),
        lastSeq: 1n,
      },
    });

  beforeAll(async () => {
    ctx = await createApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    const admin = await adminSession(ctx);
    ({ runnerId, token } = await pairedRunner(ctx, admin));
    ({ projectId: a } = await seedProject(ctx.prisma, ROOT, runnerId));
    ({ projectId: b } = await seedProject(ctx.prisma, OTHER_ROOT, runnerId));
    member = await viewerOf('a@example.com', a);
    memberOfB = await viewerOf('b@example.com', b);
    stream = new EventStream(Date.parse('2026-10-14T09:00:00Z'));
  });
  afterEach(() => {
    for (const close of closers.splice(0)) close();
  });

  describe('authorization', () => {
    it('answers 401 to an anonymous caller and 404 to a non-member', async () => {
      for (const path of routes(a)) {
        expect([path, (await ctx.http().get(path)).status]).toEqual([
          path,
          401,
        ]);
        const response = await memberOfB.get(path);
        expect([path, response.status]).toEqual([path, 404]);
        expect(response.body.error).toBe('not_found');
      }
    });

    it('answers 400 to a slot param that is not a slot name, 404 to an unknown slot', async () => {
      for (const path of routes(a).slice(1)) {
        const bad = await member.get(path.replace('i42', 'I42'));
        expect([path, bad.status, bad.body.error]).toEqual([
          path,
          400,
          'invalid_slot',
        ]);
        const unknown = await member.get(path);
        expect([path, unknown.status, unknown.body.error]).toEqual([
          path,
          404,
          'slot_not_found',
        ]);
      }
    });
  });

  describe('GET /fleet/graph', () => {
    it('is the orchestrator alone on an empty fleet', async () => {
      const response = await member.get(`/projects/${a}/fleet/graph`);
      expect(response.status).toBe(200);
      const graph = response.body as FleetGraph;
      expect(graph.nodes.map((n) => n.id)).toEqual(['orchestrator']);
      expect(graph.edges).toEqual([]);
    });

    it('draws the wave of an issue: lead, depends, a planned sibling and a merged one', async () => {
      await issue(
        160,
        'Agent workspace',
        [
          '## Parallel plan',
          '| Slot | Owns | Depends on | Lead | Model |',
          '|---|---|---|---|---|',
          '| i160-data | a | — | yes | opus |',
          '| i160-canvas | b | i160-data | no | opus |',
          '| i160-panel | c | i160-data | no | sonnet |',
          '| i160-docs | d | — | no | haiku |',
        ].join('\n'),
      );
      await issue(161, 'Analytics', 'Depends on #160');
      const socket = await runner();
      await send(socket, [
        dispatch('i160-docs', 160),
        stream.next(
          'session.appeared',
          { name: 'cs-i160-docs' },
          { slot: 'i160-docs' },
        ),
        stream.next(
          'pr.opened',
          {
            number: 9,
            branch: 'feat/i160-docs',
            url: 'https://github.com/acme/widget/pull/9',
            title: 'docs',
            checks: 'green',
          },
          { slot: 'i160-docs' },
        ),
        stream.next(
          'pr.closed',
          { number: 9, branch: 'feat/i160-docs', merged: true },
          { slot: 'i160-docs' },
        ),
        stream.next(
          'session.vanished',
          { name: 'cs-i160-docs' },
          { slot: 'i160-docs' },
        ),
        dispatch('i160-data', 160, { lead: true }),
        stream.next(
          'session.appeared',
          { name: 'cs-i160-data' },
          { slot: 'i160-data' },
        ),
        stream.next(
          'slot.checkpoint',
          { checkpoint: 'plan_ready', heading: 'plan ready', position: 1 },
          { slot: 'i160-data', source: 'scraped' },
        ),
        dispatch('i161', 161),
      ]);

      const response = await member.get(`/projects/${a}/fleet/graph`);
      expect(response.status).toBe(200);
      const graph = response.body as FleetGraph;
      expect(graph.nodes.map((n) => [n.id, n.kind, n.pill])).toEqual([
        ['orchestrator', 'orchestrator', 'paused'],
        ['slot:i161', 'slot', 'waiting'],
        ['slot:i160-data', 'slot', 'running'],
        ['slot:i160-canvas', 'planned', 'waiting'],
        ['slot:i160-panel', 'planned', 'waiting'],
        ['slot:i160-docs', 'slot', 'done'],
      ]);
      expect(graph.edges).toEqual(
        expect.arrayContaining([
          {
            from: 'slot:i160-data',
            to: 'slot:i160-canvas',
            kind: 'depends_on',
          },
          { from: 'slot:i160-data', to: 'slot:i160-panel', kind: 'depends_on' },
          { from: 'slot:i160-data', to: 'slot:i160-docs', kind: 'lead' },
          { from: 'slot:i160-data', to: 'slot:i161', kind: 'depends_on' },
          { from: 'orchestrator', to: 'slot:i160-data', kind: 'delegates' },
        ]),
      );
      expect(graph.edges).toHaveLength(5);
      const data = graph.nodes.find(
        (n) => n.id === 'slot:i160-data',
      ) as FleetSlotNode;
      expect(data).toMatchObject({
        issueTitle: 'Agent workspace',
        lead: true,
        stage: 'plan_ready',
        progress: 25,
        branch: 'feat/i160-data',
      });
      const docs = graph.nodes.find(
        (n) => n.id === 'slot:i160-docs',
      ) as FleetSlotNode;
      expect(docs).toMatchObject({ stage: 'merged', progress: 100 });
    });
  });

  describe('GET /slots/:slot/conversation', () => {
    const hash = (n: number) => n.toString(16).padStart(64, '0');

    it('interleaves both sides in time order, keeps one entry per file hash, pushes live', async () => {
      const live = new TestLiveSocket(
        `${ctx.origin.replace(/^http/, 'ws')}/live`,
        { token: member.token, origin: allowedLiveOrigin() },
      );
      closers.push(() => live.socket.close());
      await live.ready();
      await live.subscribe(`project:${a}`);

      const socket = await runner();
      const message = (body: string, fileHash: string, mode = 'replaced') =>
        stream.next(
          'slot.message_seen',
          { body, mode, fileHash, sender: 'the orchestrator (fd)' },
          { slot: 'i42', issue: 42, source: 'scraped' },
        );
      await send(socket, [
        // Another slot's message, and one of another project: never shown.
        stream.next(
          'slot.message_seen',
          { body: 'other', mode: 'replaced', fileHash: hash(9) },
          { slot: 'i7', source: 'scraped' },
        ),
        dispatch('i42', 42),
        stream.next('session.appeared', { name: 'cs-i42' }, { slot: 'i42' }),
        stream.next(
          'slot.checkpoint',
          { checkpoint: 'picked_up', heading: 'picked up', position: 0 },
          { slot: 'i42', source: 'scraped' },
        ),
        stream.next(
          'slot.checkpoint',
          {
            checkpoint: 'plan_ready',
            heading: 'plan ready',
            summary: 'the plan',
            position: 1,
          },
          { slot: 'i42', source: 'scraped' },
        ),
        message('# plan approved', hash(1)),
        message('## a correction', hash(2), 'appended'),
        // A runner restart sends the unchanged file again.
        message('# plan approved\n\n## a correction', hash(2)),
        stream.next(
          'slot.message_seen',
          { body: 'gadget', mode: 'replaced', fileHash: hash(3) },
          { slot: 'i42', root: OTHER_ROOT, source: 'scraped' },
        ),
      ]);

      const response = await member.get(
        `/projects/${a}/slots/i42/conversation`,
      );
      expect(response.status).toBe(200);
      const conversation = response.body as SlotConversation;
      expect(conversation.slot).toBe('i42');
      expect(conversation.truncated).toBe(0);
      expect(
        conversation.entries.map((e) =>
          e.from === 'worker'
            ? `worker ${e.heading}`
            : `orch ${e.mode} ${e.body}`,
        ),
      ).toEqual([
        'worker picked up',
        'worker plan ready',
        'orch replaced # plan approved',
        'orch appended ## a correction',
      ]);
      expect(conversation.entries[2]).toMatchObject({
        sender: 'the orchestrator (fd)',
        sentAt: null,
      });

      const slot = await ctx.prisma.slot.findFirstOrThrow({
        where: { projectId: a, name: 'i42' },
      });
      expect(conversation.slotId).toBe(slot.id);
      for (;;) {
        const frame = await live.next('event', 5_000);
        if ((frame.data as { kind?: string }).kind === 'conversation') {
          expect(frame.data).toEqual({ kind: 'conversation', id: slot.id });
          break;
        }
      }
    });

    it("shows only the latest run's messages", async () => {
      const socket = await runner();
      await send(socket, [
        dispatch('i42', 42),
        stream.next(
          'slot.message_seen',
          { body: 'old run', mode: 'replaced', fileHash: hash(1) },
          { slot: 'i42', source: 'scraped' },
        ),
        stream.next('session.appeared', { name: 'cs-i42' }, { slot: 'i42' }),
        stream.next('session.vanished', { name: 'cs-i42' }, { slot: 'i42' }),
        stream.next(
          'worktree.changed',
          { path: '/srv/dev/.wt-widget-i42', exists: false },
          { slot: 'i42' },
        ),
        stream.next(
          'slot.dispatched',
          { date: '2026-10-14', round: '1000', model: 'opus' },
          { slot: 'i42', issue: 42, source: 'scraped' },
        ),
        stream.next(
          'slot.message_seen',
          { body: 'new run', mode: 'replaced', fileHash: hash(2) },
          { slot: 'i42', source: 'scraped' },
        ),
      ]);
      const runs = await ctx.prisma.slot.count({
        where: { projectId: a, name: 'i42' },
      });
      expect(runs).toBe(2);
      const response = await member.get(
        `/projects/${a}/slots/i42/conversation`,
      );
      const conversation = response.body as SlotConversation;
      expect(
        conversation.entries.map((e) => e.from === 'orchestrator' && e.body),
      ).toEqual(['new run']);
    });
  });

  describe('GET /slots/:slot/worktree', () => {
    const seedSlot = async (socket: TestRunnerSocket) =>
      send(socket, [dispatch('i42', 42)]);

    it('proxies worktree.status with the root and base from the database, and caches it', async () => {
      const socket = await runner();
      const fake = new FakeRunner(socket);
      await seedSlot(socket);
      const response = await member.get(`/projects/${a}/slots/i42/worktree`);
      expect(response.status).toBe(200);
      const view = response.body as SlotWorktreeView;
      expect(view).toMatchObject({ ...STATUS });
      expect(Date.parse(view.fetchedAt)).not.toBeNaN();
      expect(fake.worktree()).toEqual([
        {
          name: 'worktree.status',
          args: { projectId: a, root: ROOT, slot: 'i42', base: 'develop' },
        },
      ]);

      const again = await member.get(`/projects/${a}/slots/i42/worktree`);
      expect(again.body).toEqual(view);
      expect(fake.worktree()).toHaveLength(1);
    });

    it('answers 409 runner_offline without a connected runner', async () => {
      const socket = await runner();
      await seedSlot(socket);
      socket.socket.terminate();
      await socket.closed;
      // The gateway drops the presence once the socket is gone.
      for (let i = 0; i < 50; i++) {
        const response = await member.get(`/projects/${a}/slots/i42/worktree`);
        if (response.status === 409) {
          expect(response.body.error).toBe('runner_offline');
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('never offline');
    });

    it('answers 409 worktree_unavailable on a runner refusal, 504 on silence, and caches neither', async () => {
      const socket = await runner();
      const fake = new FakeRunner(socket);
      await seedSlot(socket);
      fake.answer = () => ({
        ok: false,
        code: 'path_not_allowed',
        message: 'gone',
      });
      const refused = await member.get(`/projects/${a}/slots/i42/worktree`);
      expect([refused.status, refused.body.error]).toEqual([
        409,
        'worktree_unavailable',
      ]);
      expect(refused.body.message).toContain('path_not_allowed');

      fake.answer = () => 'silence';
      const silent = await member.get(`/projects/${a}/slots/i42/worktree`);
      expect([silent.status, silent.body.error]).toEqual([
        504,
        'runner_timeout',
      ]);
      expect(fake.worktree()).toHaveLength(2);
    });
  });
});
