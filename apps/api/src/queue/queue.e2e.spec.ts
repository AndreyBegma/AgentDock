import {
  QUEUE_LIVE_EVENT,
  type QueueIssueDetail,
  type QueueView,
} from '@agentdock/shared';
import type { RunnerEvent } from '@agentdock/shared/protocol';
import {
  EventStream,
  REPO,
  ROOT,
  seedProject,
} from '../fleet/testing/fleet-e2e';
import { allowedLiveOrigin } from '../live/live-options';
import {
  createLiveE2eApp,
  type LiveE2eContext,
  TestLiveSocket,
} from '../live/testing/live-e2e';
import { RunnerEventSinks } from '../runners/runner-event-sinks';
import {
  createUser,
  login,
  resetDatabase,
  type Session,
} from '../test/e2e-app';
import { QueueCommands } from './queue-commands';

const OTHER_ROOT = '/srv/dev/gadget';
const AC = '## Acceptance criteria\n- [ ] it works\n';
const FETCHED_AT = '2026-10-08T10:00:00.000Z';

const url = (n: number, kind = 'issues') =>
  `https://github.com/${REPO}/${kind}/${n}`;

const issue = (number: number, body = AC, labels: string[] = ['cs:ready']) => ({
  number,
  title: `Issue ${number}`,
  labels,
  assignees: [],
  body,
  updatedAt: '2026-10-08T09:00:00Z',
  url: url(number),
});

const pullRequest = (number: number, body: string) => ({
  number,
  title: `PR ${number}`,
  body,
  updatedAt: '2026-10-08T09:00:00Z',
  url: url(number, 'pull'),
});

describe('task queue (e2e)', () => {
  let ctx: LiveE2eContext;
  let sinks: RunnerEventSinks;
  let commands: QueueCommands;
  let runnerId: string;
  let a: string;
  let b: string;
  let viewerOfA: Session;
  let operatorOfA: Session;
  let memberOfB: Session;
  let stream: EventStream;
  const sockets: TestLiveSocket[] = [];

  const memberOf = async (
    email: string,
    projectId: string,
    role: 'viewer' | 'operator',
  ) => {
    const user = await createUser(ctx.prisma, email, role);
    await ctx.prisma.projectMember.create({
      data: { projectId, userId: user.id },
    });
    return login(ctx, email);
  };

  /** Through the registered sinks, as the runner gateway does — fleet first. */
  const ingest = (...events: RunnerEvent[]) => sinks.dispatch(runnerId, events);

  const snapshot = (
    data: {
      issues?: ReturnType<typeof issue>[];
      pullRequests?: ReturnType<typeof pullRequest>[];
      open?: number[];
      part?: number;
      parts?: number;
      snapshotId?: string;
      fetchedAt?: string;
    },
    root = ROOT,
  ) => {
    const issues = data.issues ?? [];
    const pullRequests = data.pullRequests ?? [];
    return stream.next(
      'issues.snapshot',
      {
        snapshotId: data.snapshotId ?? 's1',
        fetchedAt: data.fetchedAt ?? FETCHED_AT,
        part: data.part ?? 0,
        parts: data.parts ?? 1,
        open: data.open ?? [...issues, ...pullRequests].map((i) => i.number),
        issues,
        pullRequests,
      },
      { root },
    );
  };

  const queue = async (query = '') => {
    const response = await viewerOfA.get(`/projects/${a}/queue${query}`);
    expect(response.status).toBe(200);
    return response.body as QueueView;
  };

  const stateOf = async (number: number) =>
    (await queue()).items.find((i) => i.number === number);

  beforeAll(async () => {
    ctx = await createLiveE2eApp();
    sinks = ctx.app.get(RunnerEventSinks);
    commands = ctx.app.get(QueueCommands);
  });
  afterAll(async () => {
    for (const socket of sockets) socket.socket.close();
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ({ runnerId, projectId: a } = await seedProject(ctx.prisma));
    ({ projectId: b } = await seedProject(ctx.prisma, OTHER_ROOT, runnerId));
    viewerOfA = await memberOf('viewer-a@example.com', a, 'viewer');
    operatorOfA = await memberOf('operator-a@example.com', a, 'operator');
    memberOfB = await memberOf('operator-b@example.com', b, 'operator');
    stream = new EventStream();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('authorization', () => {
    const routes = (projectId: string) =>
      [
        ['get', `/projects/${projectId}/queue`],
        ['get', `/projects/${projectId}/queue/1`],
        ['post', `/projects/${projectId}/queue/refresh`],
        ['post', `/projects/${projectId}/issues`],
      ] as const;
    const body = { title: 'x', body: AC, labels: [], queue: false };

    it('answers 404 on every route of project A to a member of B only', async () => {
      for (const [method, path] of routes(a)) {
        const response =
          method === 'get'
            ? await memberOfB.get(path)
            : await memberOfB.send(method, path, body);
        expect([method, path, response.status]).toEqual([method, path, 404]);
        expect(response.body.error).toBe('not_found');
      }
    });

    it('answers 403 to a viewer member on both writes', async () => {
      const create = jest.spyOn(commands, 'createIssue');
      const refresh = jest.spyOn(commands, 'refreshIssues');
      for (const [, path] of routes(a).slice(2)) {
        const response = await viewerOfA.send('post', path, body);
        expect([path, response.status]).toEqual([path, 403]);
      }
      expect(create).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
    });

    it('answers 401 to an anonymous caller', async () => {
      for (const [method, path] of routes(a)) {
        const response = await ctx.http()[method](path).send(body);
        expect([path, response.status]).toEqual([path, 401]);
      }
    });
  });

  describe('state computation from a fixture snapshot (D3)', () => {
    beforeEach(async () => {
      await ingest(
        snapshot({
          issues: [
            issue(1, `${AC}\nDepends on #2\n`),
            issue(2, AC, []),
            issue(3, `${AC}\nGate: the owner signs off\n`),
            issue(4, 'Make it better.'),
            issue(5, AC, ['cs:ready', 'size: XL']),
            issue(6),
            issue(7, AC, ['cs:ready', 'priority: high']),
          ],
          pullRequests: [pullRequest(8, 'Closes #6')],
        }),
      );
    });

    it('lands each issue in its state, in priority order', async () => {
      const view = await queue();
      expect(view.snapshotAt).toBe(FETCHED_AT);
      expect(view.readyLabel).toBe('cs:ready');
      expect(view.items.map((i) => [i.number, i.state, i.source])).toEqual([
        [7, 'ready', 'computed'],
        [1, 'blocked_work', 'computed'],
        [3, 'blocked_person', 'computed'],
        [4, 'no_spec', 'computed'],
        [5, 'no_spec', 'computed'],
        [6, 'in_flight', 'computed'],
      ]);
      const blocked = view.items.find((i) => i.number === 1);
      expect(blocked?.blockers).toEqual([
        { number: 2, url: url(2), open: true },
      ]);
      expect(view.items.find((i) => i.number === 3)?.why).toBe(
        'Gate: the owner signs off',
      );
    });

    it('filters by state and lists the other open issues on request', async () => {
      expect(
        (await queue('?state=no_spec')).items.map((i) => i.number),
      ).toEqual([4, 5]);
      const view = await queue('?include=open');
      expect(view.others?.map((i) => i.number)).toEqual([2]);
      expect((await queue()).others).toBeUndefined();
      expect(
        (await viewerOfA.get(`/projects/${a}/queue?state=nope`)).status,
      ).toBe(400);
    });

    it('serves one issue with its body and blockers; 404 outside the queue', async () => {
      const response = await viewerOfA.get(`/projects/${a}/queue/1`);
      expect(response.status).toBe(200);
      const detail = response.body as QueueIssueDetail;
      expect(detail.body).toContain('Depends on #2');
      expect(detail.state).toBe('blocked_work');
      expect(detail.history).toEqual([]);
      const missing = await viewerOfA.get(`/projects/${a}/queue/2`);
      expect(missing.status).toBe(404);
      expect(missing.body.error).toBe('issue_not_found');
    });

    it('closes what a later snapshot no longer lists', async () => {
      await ingest(
        snapshot({
          snapshotId: 's2',
          issues: [issue(1, `${AC}\nDepends on #2\n`)],
          open: [1],
        }),
      );
      const row = await ctx.prisma.issueCache.findUniqueOrThrow({
        where: { projectId_number: { projectId: a, number: 6 } },
      });
      expect(row.state).toBe('closed');
      // #2 closed without a known reason still blocks #1.
      expect((await queue()).items.map((i) => [i.number, i.state])).toEqual([
        [1, 'blocked_work'],
      ]);
    });
  });

  describe('dependencies (D2, D3)', () => {
    const closeTwo = (closedBy: 'pr' | 'manual') =>
      ingest(
        snapshot({
          snapshotId: 's2',
          issues: [issue(1, `${AC}\nDepends on #2\n`)],
          open: [1],
        }),
        stream.next('issue.closed', {
          number: 2,
          closedBy,
          ...(closedBy === 'pr' ? { pr: 9 } : {}),
        }),
      );

    beforeEach(async () => {
      await ingest(
        snapshot({
          issues: [issue(1, `${AC}\nDepends on #2\n`), issue(2, AC, [])],
        }),
      );
      expect((await stateOf(1))?.state).toBe('blocked_work');
    });

    it('a dependency closed by a merged PR unblocks its dependants', async () => {
      await closeTwo('pr');
      expect(await stateOf(1)).toMatchObject({ state: 'ready', blockers: [] });
    });

    it('one closed manually keeps them BLOCKED — work', async () => {
      await closeTwo('manual');
      expect(await stateOf(1)).toMatchObject({
        state: 'blocked_work',
        blockers: [{ number: 2, open: false }],
      });
    });

    it('records the closure of a dependency never seen open', async () => {
      await ingest(
        stream.next('issue.closed', { number: 40, closedBy: 'pr', pr: 41 }),
      );
      const row = await ctx.prisma.issueCache.findUniqueOrThrow({
        where: { projectId_number: { projectId: a, number: 40 } },
      });
      expect(row).toMatchObject({
        state: 'closed',
        closedBy: 'pr',
        closingPr: 41,
        url: url(40),
      });
    });

    it('ignores a replayed snapshot', async () => {
      const stale = snapshot({ snapshotId: 's0', issues: [issue(1)] });
      await closeTwo('pr');
      const before = await queue();
      await sinks.dispatch(runnerId, [{ ...stale, seq: 1 }]);
      expect(await queue()).toEqual(before);
    });
  });

  describe("the orchestrator's verdict (D4)", () => {
    const round = (decisions: object) => [
      stream.next(
        'round.started',
        {
          date: '2026-10-08',
          round: '1015',
          base: 'develop',
          occupied: 1,
          max: 4,
          free: 3,
          boardPath: '/srv/boards/2026-10-08/round-1015.md',
        },
        { source: 'scraped' },
      ),
      stream.next(
        'round.decided',
        { date: '2026-10-08', round: '1015', decisions },
        { source: 'scraped' },
      ),
    ];

    it('wins when newer than the snapshot — in the same batch, after the fleet sink', async () => {
      await ingest(
        snapshot({ issues: [issue(1)] }),
        ...round({
          notDispatching: [
            {
              Issue: '#1',
              State: 'BLOCKED — work',
              Why: 'touches a file #9 changes',
              'What would clear it': '#9 merges',
            },
          ],
          heldForLead: [
            {
              Slot: 'i1-web',
              'Waiting on': 'i1-api',
              'Dispatch when': 'i1-api merged',
            },
          ],
        }),
      );
      const view = await queue();
      expect(view.round).toMatchObject({ date: '2026-10-08', round: '1015' });
      expect(view.heldForLead).toEqual([
        { slot: 'i1-web', waitingOn: 'i1-api', dispatchWhen: 'i1-api merged' },
      ]);
      expect(view.items[0]).toMatchObject({
        number: 1,
        state: 'blocked_work',
        why: 'touches a file #9 changes',
        clears: '#9 merges',
        source: 'orchestrator',
        computed: { state: 'ready' },
      });
      const detail = (await viewerOfA.get(`/projects/${a}/queue/1`))
        .body as QueueIssueDetail;
      expect(detail.history).toEqual([
        {
          date: '2026-10-08',
          round: '1015',
          state: 'blocked_work',
          why: 'touches a file #9 changes',
          clears: '#9 merges',
        },
      ]);
    });

    it('loses to an issue that changed after the round', async () => {
      await ingest(
        snapshot({ issues: [issue(1)] }),
        ...round({
          notDispatching: [{ Issue: '#1', State: 'NO SPEC', Why: 'x' }],
        }),
      );
      await ingest(
        snapshot({
          snapshotId: 's2',
          fetchedAt: '2026-10-08T11:00:00.000Z',
          issues: [issue(1, `${AC}\n- [ ] one more\n`)],
        }),
      );
      expect(await stateOf(1)).toMatchObject({
        state: 'ready',
        source: 'computed',
        computed: null,
      });
    });
  });

  describe('snapshot parts and the feed', () => {
    it('applies every part; each closes what is absent from the full open list', async () => {
      await ingest(
        snapshot({ issues: [issue(1), issue(2), issue(3)] }),
        snapshot({
          snapshotId: 's2',
          part: 0,
          parts: 2,
          open: [1, 4],
          issues: [issue(1)],
        }),
        snapshot({
          snapshotId: 's2',
          part: 1,
          parts: 2,
          open: [1, 4],
          issues: [issue(4)],
        }),
      );
      expect((await queue()).items.map((i) => i.number)).toEqual([1, 4]);
    });

    it('reports an unavailable feed until the next snapshot', async () => {
      await ingest(
        stream.next('issues.unavailable', { reason: 'gh: not logged in' }),
      );
      expect((await queue()).unavailable).toMatchObject({
        reason: 'gh: not logged in',
      });
      await ingest(snapshot({ issues: [issue(1)] }));
      expect((await queue()).unavailable).toBeNull();
    });
  });

  it('pushes `queue` on the project topic within 5 s of a snapshot (D9)', async () => {
    const live = new TestLiveSocket(ctx.liveUrl, {
      token: viewerOfA.token,
      origin: allowedLiveOrigin(),
    });
    sockets.push(live);
    await live.ready();
    expect((await live.subscribe(`project:${a}`)).type).toBe('subscribed');
    const started = Date.now();
    await ingest(snapshot({ issues: [issue(11)] }));
    const frame = await live.next('event', 5_000);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(frame).toMatchObject({
      topic: `project:${a}`,
      event: QUEUE_LIVE_EVENT,
      data: { kind: 'queue', projectId: a },
    });
    expect((await queue()).items.map((i) => i.number)).toEqual([11]);
  });

  describe('POST /projects/:id/issues (D7, D8)', () => {
    const post = (body: object) =>
      operatorOfA.send('post', `/projects/${a}/issues`, body);
    const audits = () =>
      ctx.prisma.auditRecord.findMany({
        // The audit chain is append-only: it outlives `resetDatabase`.
        where: { action: 'issue.create', projectId: a },
        orderBy: { seq: 'asc' },
      });

    beforeEach(async () => {
      await ingest(
        snapshot({ issues: [issue(1, AC, ['cs:ready', 'area: api'])] }),
      );
    });

    it('queues a complete body: sends issue.create and audits the result', async () => {
      const create = jest
        .spyOn(commands, 'createIssue')
        .mockResolvedValue({ number: 12, url: url(12), queued: true });
      const response = await post({
        title: 'Add a queue',
        body: AC,
        labels: ['area: api'],
        queue: true,
      });
      expect(response.status).toBe(201);
      expect(response.body).toEqual({ number: 12, url: url(12), queued: true });
      expect(create).toHaveBeenCalledWith(
        runnerId,
        {
          projectId: a,
          title: 'Add a queue',
          body: AC,
          labels: ['area: api'],
          queue: true,
        },
        expect.objectContaining({ role: 'operator' }),
      );
      const [record] = await audits();
      expect(record).toMatchObject({
        actorType: 'user',
        projectId: a,
        result: 'ok',
        after: {
          title: 'Add a queue',
          labels: ['area: api'],
          queue: true,
          number: 12,
          queued: true,
        },
      });
      expect(record.actorUserId).not.toBeNull();
    });

    it('answers 422 without acceptance criteria and sends nothing', async () => {
      const create = jest.spyOn(commands, 'createIssue');
      const response = await post({
        title: 'Vague',
        body: 'Make it better.',
        labels: [],
        queue: true,
      });
      expect(response.status).toBe(422);
      expect(response.body.error).toBe('no_acceptance_criteria');
      expect(create).not.toHaveBeenCalled();
      expect(await audits()).toMatchObject([
        { result: 'denied', after: { title: 'Vague', queue: true } },
      ]);
    });

    it('files an incomplete body unqueued', async () => {
      const create = jest
        .spyOn(commands, 'createIssue')
        .mockResolvedValue({ number: 13, url: url(13), queued: false });
      const response = await post({
        title: 'Idea',
        body: 'Make it better.',
        labels: ['enhancement'],
        queue: false,
      });
      expect(response.status).toBe(201);
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('refuses labels the repository does not use, and the ready label', async () => {
      const create = jest.spyOn(commands, 'createIssue');
      for (const labels of [['made-up'], ['CS:Ready']]) {
        const response = await post({
          title: 'x',
          body: AC,
          labels,
          queue: false,
        });
        expect(response.status).toBe(422);
        expect(response.body).toMatchObject({
          error: 'label_not_allowed',
          labels,
        });
      }
      expect(create).not.toHaveBeenCalled();
    });

    it('answers 503 and audits an error while the runner command is not wired', async () => {
      const response = await post({
        title: 'x',
        body: AC,
        labels: [],
        queue: true,
      });
      expect(response.status).toBe(503);
      expect(response.body.error).toBe('command_unavailable');
      expect(await audits()).toMatchObject([{ result: 'error' }]);
    });

    it('validates the body', async () => {
      expect(
        (await post({ title: '', body: AC, labels: [], queue: true })).status,
      ).toBe(400);
      expect(
        (await post({ title: '   ', body: AC, labels: [], queue: false }))
          .status,
      ).toBe(400);
      expect(
        (
          await post({
            title: 'x',
            body: AC,
            labels: [],
            queue: true,
            extra: 1,
          })
        ).status,
      ).toBe(400);
    });
  });

  describe('POST /projects/:id/queue/refresh', () => {
    it('asks the runner for a poll', async () => {
      const refresh = jest
        .spyOn(commands, 'refreshIssues')
        .mockResolvedValue({ changed: true, fetchedAt: FETCHED_AT });
      const response = await operatorOfA.send(
        'post',
        `/projects/${a}/queue/refresh`,
      );
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ changed: true, fetchedAt: FETCHED_AT });
      expect(refresh).toHaveBeenCalledWith(
        runnerId,
        { projectId: a },
        expect.objectContaining({ role: 'operator' }),
      );
    });

    it('answers 503 while the runner command is not wired', async () => {
      const response = await operatorOfA.send(
        'post',
        `/projects/${a}/queue/refresh`,
      );
      expect(response.status).toBe(503);
    });
  });
});
