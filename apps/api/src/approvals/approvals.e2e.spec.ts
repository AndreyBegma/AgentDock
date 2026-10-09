import {
  APPROVAL_DECIDED_LIVE_EVENT,
  APPROVALS_LIVE_EVENT,
  type ApprovalDetail,
  type ApprovalsView,
} from '@agentdock/shared';
import type { PrInspection, RunnerEvent } from '@agentdock/shared/protocol';
import { EventStream, ROOT, seedProject } from '../fleet/testing/fleet-e2e';
import { allowedLiveOrigin } from '../live/live-options';
import {
  createLiveE2eApp,
  type LiveE2eContext,
  TestLiveSocket,
} from '../live/testing/live-e2e';
import { RunnerEventSinks } from '../runners/runner-event-sinks';
import { eventually } from '../runners/testing/runner-e2e';
import {
  createUser,
  login,
  resetDatabase,
  type Session,
} from '../test/e2e-app';
import { ApprovalCommands } from './approval-commands';

const OTHER_ROOT = '/srv/dev/gadget';
const PR = 51;
const PR_URL = `https://github.com/acme/widget/pull/${PR}`;
const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const SUMMARY = '**What changed** — the widget.';

const inspection = (
  headSha: string,
  state: PrInspection['state'] = 'open',
): PrInspection => ({
  number: PR,
  url: PR_URL,
  title: 'feat: widget',
  body: 'Closes #42',
  state,
  headSha,
  additions: 120,
  deletions: 4,
  changedFiles: 1,
  files: [{ path: 'src/widget.ts', additions: 120, deletions: 4 }],
  filesTruncated: false,
  checks: 'green',
  checkList: [{ name: 'ci', state: 'pass' }],
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  fetchedAt: '2026-10-08T10:00:00.000Z',
});

const signal = { written: true as const };

describe('merge approval queue (e2e)', () => {
  let ctx: LiveE2eContext;
  let sinks: RunnerEventSinks;
  let commands: ApprovalCommands;
  let runnerId: string;
  let a: string;
  let b: string;
  let viewerOfA: Session;
  let operatorOfA: Session;
  let operatorOfAId: string;
  let memberOfB: Session;
  let outsider: Session;
  let stream: EventStream;
  /** The head `pr.inspect` answers with; null: the command is not wired. */
  let head: string | null;
  let prState: PrInspection['state'];
  const sockets: TestLiveSocket[] = [];

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
    return { session: await login(ctx, email), id: user.id };
  };

  /** Through the registered sinks, as the runner gateway does — fleet first. */
  const ingest = (...events: RunnerEvent[]) => sinks.dispatch(runnerId, events);

  /** What the gateway does after the sinks: store the batch. */
  const store = (...events: RunnerEvent[]) =>
    ctx.prisma.event.createMany({
      data: events.map((e) => ({
        runnerId,
        seq: BigInt(e.seq),
        ts: new Date(e.ts),
        type: e.type,
        source: e.source,
        projectRoot: e.project?.root ?? null,
        projectRepo: e.project?.repo ?? null,
        slot: e.slot ?? null,
        issue: e.issue ?? null,
        data: (e.data ?? {}) as object,
      })),
    });

  /** Slot `i42` with PR #51, green and mergeable, and its merge summary (D3). */
  const seedSlot = async (projectId = a) => {
    const at = new Date('2026-10-08T09:00:00Z');
    const slot = await ctx.prisma.slot.create({
      data: {
        projectId,
        name: 'i42',
        issue: 42,
        branch: 'feat/42-widget',
        worktree: '/srv/dev/.wt-widget-i42',
        owns: [],
        never: [],
        status: 'running',
        prNumber: PR,
        prUrl: PR_URL,
        prState: 'open',
        prChecks: 'green',
        prMergeable: true,
        lastCheckpoint: 'pr_open',
        lastSeq: 0n,
        startedAt: at,
        updatedAt: at,
      },
    });
    await ctx.prisma.slotCheckpoint.create({
      data: {
        slotId: slot.id,
        kind: 'pr_open',
        heading: `pull request open — ${PR_URL}`,
        summary: SUMMARY,
        position: 3,
        at,
      },
    });
  };

  const awaiting = () =>
    stream.next(
      'pr.awaiting_approval',
      { pr: PR },
      { source: 'code-sentinel', slot: 'i42', issue: 42 },
    );

  const checksChanged = (checks: 'pending' | 'green' | 'red' = 'green') =>
    stream.next('pr.checks_changed', {
      number: PR,
      branch: 'feat/42-widget',
      checks,
      mergeable: true,
    });

  const list = async (session = viewerOfA, query = '') => {
    const response = await session.get(`/projects/${a}/approvals${query}`);
    expect(response.status).toBe(200);
    return response.body as ApprovalsView;
  };

  const rows = () =>
    ctx.prisma.mergeApproval.findMany({
      where: { projectId: a },
      orderBy: { createdAt: 'asc' },
    });

  /** This test's records: the audit log is append-only. */
  const audits = (action: string) =>
    ctx.prisma.auditRecord.findMany({
      where: { action, projectId: a },
      orderBy: { seq: 'asc' },
    });

  const approve = (headSha: string, session = operatorOfA) =>
    session.send('post', `/projects/${a}/approvals/${PR}/approve`, {
      headSha,
    });

  const requestChanges = (body: object, session = operatorOfA) =>
    session.send(
      'post',
      `/projects/${a}/approvals/${PR}/request-changes`,
      body,
    );

  const liveOn = async (session: Session) => {
    const live = new TestLiveSocket(ctx.liveUrl, {
      token: session.token,
      origin: allowedLiveOrigin(),
    });
    sockets.push(live);
    await live.ready();
    expect((await live.subscribe(`project:${a}`)).type).toBe('subscribed');
    return live;
  };

  /** The next live event named `name`, skipping other modules' events. */
  const nextNamed = async (live: TestLiveSocket, name: string, ms = 5_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const frame = await live.next(
        'event',
        Math.max(1, deadline - Date.now()),
      );
      if (frame.event === name) return frame;
    }
  };

  beforeAll(async () => {
    ctx = await createLiveE2eApp();
    sinks = ctx.app.get(RunnerEventSinks);
    commands = ctx.app.get(ApprovalCommands);
  });
  afterAll(async () => {
    for (const socket of sockets) socket.socket.close();
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ({ runnerId, projectId: a } = await seedProject(ctx.prisma));
    ({ projectId: b } = await seedProject(ctx.prisma, OTHER_ROOT, runnerId));
    viewerOfA = (await memberOf('viewer-a@example.com', a, 'viewer')).session;
    const operator = await memberOf('operator-a@example.com', a, 'operator');
    operatorOfA = operator.session;
    operatorOfAId = operator.id;
    memberOfB = (await memberOf('operator-b@example.com', b, 'operator'))
      .session;
    outsider = (await memberOf('outsider@example.com', null, 'operator'))
      .session;
    stream = new EventStream();
    head = H1;
    prState = 'open';
    jest
      .spyOn(commands, 'inspect')
      .mockImplementation(async (_runner, args) => {
        if (!head) throw new Error('not wired in this test');
        expect(args).toEqual({ projectId: a, root: ROOT, pr: PR });
        return inspection(head, prState);
      });
    jest.spyOn(commands, 'approve').mockResolvedValue(signal);
    jest.spyOn(commands, 'requestChanges').mockResolvedValue(signal);
    jest.spyOn(commands, 'voidApproval').mockResolvedValue(signal);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('authorization (D9)', () => {
    const routes = (projectId: string) =>
      [
        ['get', `/projects/${projectId}/approvals`],
        ['get', `/projects/${projectId}/approvals/${PR}`],
        ['post', `/projects/${projectId}/approvals/${PR}/approve`],
        ['post', `/projects/${projectId}/approvals/${PR}/request-changes`],
      ] as const;
    const body = { headSha: H1, note: 'please fix' };

    beforeEach(async () => {
      await seedSlot();
      await ingest(awaiting());
    });

    it('answers 404 on every route of project A to a member of B only, and to a non-member', async () => {
      for (const session of [memberOfB, outsider]) {
        for (const [method, path] of routes(a)) {
          const response =
            method === 'get'
              ? await session.get(path)
              : await session.send(method, path, body);
          expect([method, path, response.status]).toEqual([method, path, 404]);
          expect(response.body.error).toBe('not_found');
        }
      }
    });

    it('answers 403 to a viewer member on approve and request-changes, and sends nothing', async () => {
      for (const [, path] of routes(a).slice(2)) {
        const response = await viewerOfA.send('post', path, body);
        expect([path, response.status]).toEqual([path, 403]);
      }
      expect(commands.approve).not.toHaveBeenCalled();
      expect(commands.requestChanges).not.toHaveBeenCalled();
      expect((await rows())[0].status).toBe('waiting');
    });

    it('answers 401 to an anonymous caller on every route', async () => {
      for (const [method, path] of routes(a)) {
        const response = await ctx.http()[method](path).send(body);
        expect([path, response.status]).toEqual([path, 401]);
      }
    });

    it('lets a viewer member list and open the queue', async () => {
      expect((await list()).waiting).toHaveLength(1);
      const response = await viewerOfA.get(`/projects/${a}/approvals/${PR}`);
      expect(response.status).toBe(200);
    });
  });

  describe('awaiting approval (D2)', () => {
    it('opens a waiting row on pr.awaiting_approval and pushes `approvals` within 5 s', async () => {
      await seedSlot();
      const live = await liveOn(viewerOfA);
      const started = Date.now();
      await ingest(awaiting());
      const frame = await nextNamed(live, APPROVALS_LIVE_EVENT);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(frame.data).toEqual({ kind: 'approvals', projectId: a });

      const view = await list();
      expect(view.waiting).toEqual([
        expect.objectContaining({
          pr: PR,
          url: PR_URL,
          slot: 'i42',
          issue: 42,
          checks: 'green',
          mergeable: true,
          summary: SUMMARY,
          source: 'orchestrator',
          status: 'waiting',
          headSha: null,
          decidedBy: null,
        }),
      ]);
      expect(view.recent).toEqual([]);
    });

    it('is idempotent: a resent batch and a repeated event open one row', async () => {
      const event = awaiting();
      await ingest(event);
      await store(event);
      await ingest(event);
      await ingest(awaiting());
      expect(await rows()).toHaveLength(1);
    });

    it('lists a PR without a summary as "no summary written" (null)', async () => {
      await ingest(awaiting());
      expect((await list()).waiting[0]).toMatchObject({
        summary: null,
        slot: 'i42',
      });
    });

    describe('derived, with no events source', () => {
      beforeEach(async () => {
        await seedSlot();
        await ctx.prisma.project.update({
          where: { id: a },
          data: {
            codeSentinelConfig: { orchestrator: { mergeApproval: true } },
          },
        });
      });

      it('lists a green, mergeable PR with a pr_open checkpoint as source: derived', async () => {
        await ingest(checksChanged('green'));
        expect((await list()).waiting).toEqual([
          expect.objectContaining({
            pr: PR,
            source: 'derived',
            status: 'waiting',
          }),
        ]);
      });

      it('derives nothing while the plugin emits events', async () => {
        const plugin = stream.next(
          'orchestrator.started',
          { session: 'cs-orch' },
          { source: 'code-sentinel' },
        );
        await store(plugin);
        await ingest(checksChanged('green'));
        expect(await rows()).toEqual([]);
      });

      it('derives nothing when the config does not ask for approval', async () => {
        await ctx.prisma.project.update({
          where: { id: a },
          data: { codeSentinelConfig: { orchestrator: {} } },
        });
        await ingest(checksChanged('green'));
        expect(await rows()).toEqual([]);
      });

      it('drops the undecided row when checks leave green, and the plugin adopts a derived row', async () => {
        await ingest(checksChanged('green'));
        await ingest(checksChanged('pending'));
        expect(await rows()).toEqual([]);
        await ingest(checksChanged('green'));
        await ingest(awaiting());
        expect(await rows()).toEqual([
          expect.objectContaining({
            source: 'orchestrator',
            status: 'waiting',
          }),
        ]);
      });
    });

    it('closes the current row on pr.merged', async () => {
      await ingest(awaiting());
      await ingest(stream.next('pr.merged', { number: PR }));
      const view = await list();
      expect(view.waiting).toEqual([]);
      expect(view.recent).toEqual([
        expect.objectContaining({ pr: PR, status: 'merged' }),
      ]);
    });
  });

  describe('approve (D5, D6, D8)', () => {
    beforeEach(async () => {
      await seedSlot();
      await ingest(awaiting());
    });

    it('with the current head: sends pr.approve, marks the row approved, audits and publishes', async () => {
      const live = await liveOn(viewerOfA);
      const response = await approve(H1);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        pr: PR,
        status: 'approved',
        headSha: H1,
        decidedBy: { id: operatorOfAId, email: 'operator-a@example.com' },
      });

      expect(commands.approve).toHaveBeenCalledTimes(1);
      const [sentRunner, args] = jest.mocked(commands.approve).mock.calls[0];
      expect(sentRunner).toBe(runnerId);
      expect(args).toMatchObject({
        projectId: a,
        root: ROOT,
        pr: PR,
        headSha: H1,
        by: 'operator-a@example.com',
      });

      const [record] = await audits('approval.approve');
      expect(record).toMatchObject({
        actorType: 'user',
        actorUserId: operatorOfAId,
        result: 'ok',
        targetType: 'pull_request',
        targetId: String(PR),
        after: { pr: PR, headSha: H1, decision: 'approved' },
      });

      const decided = await nextNamed(live, APPROVAL_DECIDED_LIVE_EVENT);
      expect(decided.data).toMatchObject({
        projectId: a,
        pr: PR,
        headSha: H1,
        decision: 'approved',
        by: { id: operatorOfAId },
      });
      expect((await list()).waiting[0]).toMatchObject({ status: 'approved' });
    });

    it('with an outdated head: 409 head_moved, nothing sent, audited as denied', async () => {
      head = H2;
      const response = await approve(H1);
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        error: 'head_moved',
        headSha: H2,
      });
      expect(commands.approve).not.toHaveBeenCalled();
      expect((await rows())[0]).toMatchObject({
        status: 'waiting',
        headSha: null,
      });
      const [record] = await audits('approval.approve');
      expect(record).toMatchObject({
        result: 'denied',
        after: { pr: PR, headSha: H1, decision: 'approved' },
      });
    });

    it('refuses a malformed head with 400 before anything runs', async () => {
      const response = await approve('HEAD');
      expect(response.status).toBe(400);
      expect(commands.inspect).not.toHaveBeenCalled();
    });

    it('refuses a merged PR with 409 pr_not_open', async () => {
      prState = 'merged';
      const response = await approve(H1);
      expect(response.status).toBe(409);
      expect(response.body.error).toBe('pr_not_open');
      expect(commands.approve).not.toHaveBeenCalled();
    });

    it('answers 404 approval_not_found for a PR not in the queue', async () => {
      const response = await operatorOfA.send(
        'post',
        `/projects/${a}/approvals/999/approve`,
        { headSha: H1 },
      );
      expect(response.status).toBe(404);
      expect(response.body.error).toBe('approval_not_found');
    });

    it('answers 409 not_waiting to a second approval of the same head', async () => {
      expect((await approve(H1)).status).toBe(200);
      const again = await approve(H1);
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('not_waiting');
      expect(commands.approve).toHaveBeenCalledTimes(1);
    });

    it('answers 503 command_unavailable when the runner does not answer (real RunnerCommandService, no runner connected), and records the error', async () => {
      jest.restoreAllMocks();
      const response = await approve(H1);
      expect(response.status).toBe(503);
      expect(response.body.error).toBe('command_unavailable');
      expect((await rows())[0].status).toBe('waiting');
      const [record] = await audits('approval.approve');
      expect(record.result).toBe('error');
    });

    it('voids an approval when the head moves: stale row, new waiting row, signal withdrawn, audited (D6)', async () => {
      expect((await approve(H1)).status).toBe(200);
      const live = await liveOn(viewerOfA);
      head = H2;
      await ingest(checksChanged('pending'));

      const current = await eventually('the approval is voided', async () => {
        const all = await rows();
        return all.length === 2 ? all : undefined;
      });
      expect(current.map((r) => [r.status, r.headSha])).toEqual([
        ['stale', H1],
        ['waiting', null],
      ]);
      expect(commands.voidApproval).toHaveBeenCalledWith(
        runnerId,
        expect.objectContaining({
          projectId: a,
          root: ROOT,
          pr: PR,
          headSha: H1,
        }),
        expect.objectContaining({ ctx: { actor: { type: 'system' } } }),
      );
      const record = await eventually(
        'the void is audited',
        async () => (await audits('approval.void'))[0],
      );
      expect(record).toMatchObject({
        actorType: 'system',
        result: 'ok',
        after: { pr: PR, headSha: H1, newHeadSha: H2, decision: 'stale' },
      });
      const decided = await nextNamed(live, APPROVAL_DECIDED_LIVE_EVENT);
      expect(decided.data).toMatchObject({ decision: 'stale', headSha: H1 });

      // The new head can be approved in turn.
      expect((await approve(H2)).status).toBe(200);
      expect((await list()).waiting).toEqual([
        expect.objectContaining({ status: 'approved', headSha: H2 }),
      ]);
    });

    it('voids on opening the detail when the head moved', async () => {
      // Approved earlier — no inspection of this PR is cached (D4: 60 s).
      await ctx.prisma.mergeApproval.updateMany({
        where: { projectId: a },
        data: {
          status: 'approved',
          headSha: H1,
          decidedById: operatorOfAId,
          decidedAt: new Date(),
        },
      });
      head = H2;
      const response = await viewerOfA.get(`/projects/${a}/approvals/${PR}`);
      expect(response.status).toBe(200);
      const detail = response.body as ApprovalDetail;
      expect(detail).toMatchObject({ status: 'waiting', headSha: null });
      expect(detail.inspection?.headSha).toBe(H2);
      expect(detail.history).toEqual([
        expect.objectContaining({ status: 'stale', headSha: H1 }),
      ]);
    });
  });

  describe('request changes (D7)', () => {
    beforeEach(async () => {
      await seedSlot();
      await ingest(awaiting());
    });

    it('answers 422 note_required without a note, or with a blank one', async () => {
      for (const body of [{ headSha: H1 }, { headSha: H1, note: '  \n ' }]) {
        const response = await requestChanges(body);
        expect(response.status).toBe(422);
        expect(response.body.error).toBe('note_required');
      }
      expect(commands.requestChanges).not.toHaveBeenCalled();
    });

    it('answers 422 note_too_long over 4 KB', async () => {
      const response = await requestChanges({
        headSha: H1,
        note: 'x'.repeat(4097),
      });
      expect(response.status).toBe(422);
      expect(response.body.error).toBe('note_too_long');
    });

    it('with a note: sends pr.requestChanges with it, and the PR leaves the waiting list', async () => {
      const response = await requestChanges({
        headSha: H1,
        note: 'Split the migration.',
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        status: 'changes_requested',
        headSha: H1,
        note: 'Split the migration.',
      });
      expect(commands.requestChanges).toHaveBeenCalledWith(
        runnerId,
        expect.objectContaining({ headSha: H1, note: 'Split the migration.' }),
        expect.anything(),
      );
      const view = await list();
      expect(view.waiting).toEqual([]);
      expect(view.recent).toEqual([
        expect.objectContaining({ status: 'changes_requested' }),
      ]);
      const [record] = await audits('approval.request_changes');
      expect(record).toMatchObject({
        actorUserId: operatorOfAId,
        result: 'ok',
        after: {
          pr: PR,
          headSha: H1,
          decision: 'changes_requested',
          note: 'Split the migration.',
        },
      });
    });
  });

  describe('detail and the config mismatch (D1, D4)', () => {
    beforeEach(async () => {
      await seedSlot();
      await ingest(awaiting());
    });

    it('returns the inspection, cached for 60 s', async () => {
      const first = await viewerOfA.get(`/projects/${a}/approvals/${PR}`);
      const second = await viewerOfA.get(`/projects/${a}/approvals/${PR}`);
      expect(first.status).toBe(200);
      expect((first.body as ApprovalDetail).inspection).toMatchObject({
        headSha: H1,
        additions: 120,
        files: [{ path: 'src/widget.ts' }],
      });
      expect(second.body.inspection).toEqual(first.body.inspection);
      expect(commands.inspect).toHaveBeenCalledTimes(1);
    });

    it('says why there is no inspection when the runner cannot answer', async () => {
      jest.restoreAllMocks();
      const response = await viewerOfA.get(`/projects/${a}/approvals/${PR}`);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        status: 'waiting',
        inspection: null,
        inspectionError: { code: 'command_unavailable' },
      });
    });

    it('flags a mismatch between AgentDock’s flag and the config', async () => {
      await ctx.prisma.project.update({
        where: { id: a },
        data: {
          mergeApproval: true,
          codeSentinelConfig: { orchestrator: {} },
        },
      });
      expect(await list()).toMatchObject({
        mergeApproval: { agentdock: true, config: false },
        configMismatch: true,
      });
      await ctx.prisma.project.update({
        where: { id: a },
        data: {
          codeSentinelConfig: { orchestrator: { mergeApproval: true } },
        },
      });
      expect(await list()).toMatchObject({
        mergeApproval: { agentdock: true, config: true },
        configMismatch: false,
      });
    });

    it('filters by status', async () => {
      expect((await list(viewerOfA, '?status=approved')).waiting).toEqual([]);
      expect((await list(viewerOfA, '?status=waiting')).waiting).toHaveLength(
        1,
      );
      const bad = await viewerOfA.get(`/projects/${a}/approvals?status=nope`);
      expect(bad.status).toBe(400);
    });
  });
});
