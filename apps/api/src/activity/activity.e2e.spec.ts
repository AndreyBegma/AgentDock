import type { ActivityItem, ActivityPage } from '@agentdock/shared';
import type { RunnerEvent } from '@agentdock/shared/protocol';
import { EventStream, ROOT, seedProject } from '../fleet/testing/fleet-e2e';
import { LiveService } from '../live/live.service';
import {
  createE2eApp,
  createUser,
  type E2eContext,
  login,
  resetDatabase,
  type Session,
} from '../test/e2e-app';
import { ACTIVITY_OPTIONS, type ActivityOptions } from './activity-options';
import { ActivityProjector } from './activity-projector.service';
import { ActivityRetentionJob } from './activity-retention.job';
import { itemRows, resetActivity, storeEvents } from './testing/activity-e2e';

const OTHER_ROOT = '/srv/dev/other';
const DAY_MS = 24 * 60 * 60 * 1000;

describe('activity feed (e2e)', () => {
  let ctx: E2eContext;
  let projector: ActivityProjector;
  let runnerId: string;
  let projectA: string;
  let projectB: string;
  let stream: EventStream;

  const store = (...events: RunnerEvent[]) =>
    storeEvents(ctx.prisma, runnerId, events);

  /** The ten curated fleet events of the fixture, all on project A. */
  const curated = (): RunnerEvent[] => [
    stream.next('orchestrator.started', { session: 'cs-orch' }),
    stream.next('round.started', {
      date: '2026-10-08',
      round: '1430',
      occupied: 1,
      max: 4,
      free: 3,
      boardPath: `${ROOT}/round.md`,
    }),
    stream.next(
      'slot.dispatched',
      { model: 'opus' },
      { slot: 'i21', issue: 21 },
    ),
    stream.next(
      'slot.checkpoint',
      { checkpoint: 'plan_ready', summary: 'the plan' },
      { slot: 'i21', issue: 21 },
    ),
    stream.next(
      'pr.opened',
      {
        number: 7,
        branch: 'feat/21',
        url: 'https://github.com/acme/widget/pull/7',
        title: 'feed',
        checks: 'pending',
      },
      { slot: 'i21' },
    ),
    stream.next(
      'pr.checks_changed',
      { number: 7, branch: 'feat/21', checks: 'green' },
      { slot: 'i21' },
    ),
    stream.next('pr.merged', { number: 7 }, { slot: 'i21' }),
    stream.next('person.needed', {
      question: 'which base?',
      recommendation: 'develop',
    }),
    stream.next('pane.quota_hit', { target: 'slot' }, { slot: 'i21' }),
    stream.next('session.vanished', { name: 'cs-i21' }, { slot: 'i21' }),
  ];

  const noise = (count: number, type: string, data: unknown) =>
    Array.from({ length: count }, () =>
      stream.next(type, data, { slot: 'i21' }),
    );

  /**
   * A projector as the API builds it on start. No gap grace: every suite's
   * TRUNCATE leaves the `events.id` sequence above the reset cursor, a hole
   * the gap logic (event-frontier.spec.ts) would otherwise wait out.
   */
  const restart = () =>
    new ActivityProjector(ctx.prisma, ctx.app.get(LiveService), {
      ...ctx.app.get<ActivityOptions>(ACTIVITY_OPTIONS),
      gapGraceMs: 0,
    });

  beforeAll(async () => {
    ctx = await createE2eApp();
  });
  afterAll(() => ctx.app.close());

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await resetActivity(ctx.prisma);
    ({ runnerId, projectId: projectA } = await seedProject(ctx.prisma));
    ({ projectId: projectB } = await seedProject(
      ctx.prisma,
      OTHER_ROOT,
      runnerId,
    ));
    stream = new EventStream();
    projector = restart();
  });

  const eventItems = () =>
    ctx.prisma.activityItem.findMany({
      where: { sourceKind: 'event' },
      orderBy: { sourceId: 'asc' },
    });

  describe('projection', () => {
    it('makes exactly one item per curated event, and none on replay', async () => {
      const events = [
        ...noise(500, 'llm.request', { requestId: 'r', model: 'm' }),
        ...curated().slice(0, 5),
        ...noise(50, 'pane.idle', { polls: 3 }),
        ...noise(500, 'llm.request', { requestId: 'r', model: 'm' }),
      ];
      events.push(...curated().slice(5));
      await store(...events);

      await projector.tick();
      const items = await eventItems();
      expect(items).toHaveLength(10);
      expect(items.every((i) => i.projectId === projectA)).toBe(true);
      expect(await projector.tick()).toBe(0);
      expect(await eventItems()).toHaveLength(10);
    });

    it('rebuilds identical rows when replayed from cursor 0', async () => {
      await store(...curated(), ...noise(20, 'llm.request', {}));
      await projector.tick();
      const before = await itemRows(ctx.prisma);

      await ctx.prisma.$executeRawUnsafe(
        'TRUNCATE TABLE activity_items, activity_projector_state',
      );
      await restart().tick();
      expect(await itemRows(ctx.prisma)).toEqual(before);
    });

    it('resumes from the stored cursors after a restart, with no gap and no duplicate', async () => {
      const events = curated();
      await store(...events.slice(0, 4));
      await projector.tick();
      await store(...events.slice(4));

      expect(await restart().tick()).toBe(6);
      const items = await eventItems();
      expect(items).toHaveLength(10);
      expect(new Set(items.map((i) => i.sourceId)).size).toBe(10);
      const state = await ctx.prisma.activityProjectorState.findUniqueOrThrow({
        where: { id: 'activity' },
      });
      const last = await ctx.prisma.event.findFirstOrThrow({
        orderBy: { id: 'desc' },
      });
      expect(state.eventsCursor).toBe(last.id);
    });

    it('shows an event under the project its root maps to; an unmapped one makes no item and does not stall', async () => {
      await store(
        stream.next('orchestrator.started', { session: 'a' }),
        stream.next(
          'orchestrator.started',
          { session: 'b' },
          { root: OTHER_ROOT },
        ),
        stream.next(
          'orchestrator.started',
          { session: 'x' },
          { root: '/srv/dev/unknown' },
        ),
        stream.next('orchestrator.stopped', { reason: 'done' }),
      );
      await projector.tick();
      const items = await eventItems();
      expect(items.map((i) => [i.type, i.projectId])).toEqual([
        ['orchestrator.started', projectA],
        ['orchestrator.started', projectB],
        ['orchestrator.stopped', projectA],
      ]);
      const state = await ctx.prisma.activityProjectorState.findUniqueOrThrow({
        where: { id: 'activity' },
      });
      const last = await ctx.prisma.event.findFirstOrThrow({
        orderBy: { id: 'desc' },
      });
      expect(state.eventsCursor).toBe(last.id);
    });

    it('keeps a runner-level event project-less', async () => {
      const truncated = stream.next('runner.spool_truncated', {
        fromSeq: 3,
        toSeq: 9,
        bytes: 10,
      });
      delete truncated.project;
      await store(truncated);
      await projector.tick();
      expect(await eventItems()).toEqual([
        expect.objectContaining({ projectId: null, category: 'runner' }),
      ]);
    });

    it('never shows duplicates, unparsed lines or plugin echoes', async () => {
      await store(
        stream.next('events.duplicate', {
          pluginEventId: 'e1',
          type: 'pr.merged',
        }),
        stream.next('events.unparsed', {
          file: 'events.jsonl',
          line: '{',
          reason: 'json',
        }),
        stream.next(
          'pane.prompt',
          { target: 'slot', via: 'watch' },
          { slot: 'i21', source: 'code-sentinel' },
        ),
        stream.next(
          'pane.prompt',
          { target: 'slot', dialog: 'trust' },
          { slot: 'i21' },
        ),
      );
      await projector.tick();
      expect((await eventItems()).map((i) => [i.type, i.title])).toEqual([
        ['pane.prompt', 'i21 waits on a trust prompt'],
      ]);
    });

    it('skips a scraped checkpoint once the plugin channel is live', async () => {
      // Separate batches: `receivedAt` is the insert's time.
      await store(
        stream.next(
          'slot.checkpoint',
          { checkpoint: 'picked_up', summary: '', position: 0 },
          { slot: 'i21', source: 'scraped' },
        ),
      );
      await store(
        stream.next(
          'slot.checkpoint',
          { checkpoint: 'plan_ready', summary: 'plan', pluginEventId: 'e2' },
          { slot: 'i21', source: 'code-sentinel' },
        ),
      );
      await store(
        stream.next(
          'slot.checkpoint',
          { checkpoint: 'plan_ready', summary: 'plan', position: 1 },
          { slot: 'i21', source: 'scraped' },
        ),
      );
      await projector.tick();
      // The first scraped one came before any plugin event: it is the only copy.
      expect((await eventItems()).map((i) => i.data)).toEqual([
        expect.objectContaining({ checkpoint: 'picked_up' }),
        expect.objectContaining({ checkpoint: 'plan_ready' }),
      ]);
    });
  });

  describe('audit records', () => {
    it('shows user.approve as audit with the admin as actor, and no successful sign-in', async () => {
      const admin = await createUser(ctx.prisma, 'admin@example.com', 'admin');
      const pending = await createUser(
        ctx.prisma,
        'new@example.com',
        'viewer',
        'pending',
      );
      const session = await login(ctx, 'admin@example.com');
      await session
        .send('post', `/admin/users/${pending.id}/approve`, { role: 'viewer' })
        .expect(200);

      await projector.tick();
      const login_ = await ctx.prisma.auditRecord.findFirstOrThrow({
        where: { action: 'auth.login', actorUserId: admin.id, result: 'ok' },
      });
      expect(
        await ctx.prisma.activityItem.findUnique({
          where: {
            sourceKind_sourceId: { sourceKind: 'audit', sourceId: login_.seq },
          },
        }),
      ).toBeNull();
      const approve = await ctx.prisma.activityItem.findFirstOrThrow({
        where: { type: 'user.approve', actorId: admin.id },
      });
      expect(approve).toMatchObject({
        category: 'audit',
        actorType: 'user',
        projectId: null,
      });

      const page = await session.get('/activity?category=audit').expect(200);
      expect((page.body as ActivityPage).items).toContainEqual(
        expect.objectContaining({
          type: 'user.approve',
          actorEmail: 'admin@example.com',
        }),
      );
    });
  });

  describe('authorization (D10)', () => {
    let admin: Session;
    let member: Session;
    let runB: string;

    beforeEach(async () => {
      await createUser(ctx.prisma, 'admin@example.com', 'admin');
      const user = await createUser(
        ctx.prisma,
        'member@example.com',
        'operator',
      );
      await ctx.prisma.projectMember.create({
        data: { projectId: projectA, userId: user.id },
      });
      admin = await login(ctx, 'admin@example.com');
      member = await login(ctx, 'member@example.com');

      const truncated = stream.next('runner.spool_truncated', {
        fromSeq: 1,
        toSeq: 2,
        bytes: 1,
      });
      delete truncated.project;
      await store(
        stream.next('orchestrator.started', { session: 'a' }),
        stream.next(
          'orchestrator.started',
          { session: 'b' },
          { root: OTHER_ROOT },
        ),
        truncated,
      );
      await projector.tick();
      const slot = await ctx.prisma.slot.create({
        data: {
          projectId: projectB,
          name: 'i9',
          worktree: '/srv/dev/.wt-other-i9',
          owns: [],
          never: [],
          status: 'running',
          lastSeq: 1n,
          startedAt: new Date('2026-10-08T10:00:00Z'),
          updatedAt: new Date('2026-10-08T10:00:00Z'),
        },
      });
      const run = await ctx.prisma.run.create({
        data: {
          kind: 'orchestrator_slot',
          projectId: projectB,
          slotId: slot.id,
          status: 'running',
          triggeredByType: 'orchestrator',
          startedAt: slot.startedAt,
          slotSeq: 1n,
          updatedAt: slot.updatedAt,
        },
      });
      runB = run.id;
    });

    const projectsOf = (page: ActivityPage) =>
      new Set(page.items.map((i: ActivityItem) => i.projectId));

    it('gives a member of A only A’s items, never B’s nor project-less ones', async () => {
      const own = await member.get('/activity').expect(200);
      expect(projectsOf(own.body)).toEqual(new Set([projectA]));
      const asked = await member
        .get(`/activity?projectId=${projectB}`)
        .expect(200);
      expect((asked.body as ActivityPage).items).toEqual([]);
    });

    it('gives an admin every item, project-less ones included', async () => {
      // By category: earlier suites' audit records, re-projected from cursor
      // 0, are newer than these fixture events and would fill a page.
      const fleet = await admin.get('/activity?category=fleet').expect(200);
      expect(projectsOf(fleet.body)).toEqual(new Set([projectA, projectB]));
      const runner = await admin.get('/activity?category=runner').expect(200);
      expect(projectsOf(runner.body)).toEqual(new Set([null]));
    });

    it('answers 404 on project B’s routes to a member of A only', async () => {
      await member.get(`/projects/${projectB}/activity`).expect(404);
      await member.get(`/projects/${projectB}/runs`).expect(404);
      await member.get(`/projects/${projectB}/runs/${runB}`).expect(404);
      await member.get(`/projects/${projectA}/activity`).expect(200);
      await admin.get(`/projects/${projectB}/runs/${runB}`).expect(200);
    });

    it('answers 401 without a session', async () => {
      await ctx.http().get('/activity').expect(401);
    });
  });

  describe('pagination (D11)', () => {
    it('keeps pages stable while newer items arrive on top', async () => {
      await store(...curated());
      await projector.tick();
      await createUser(ctx.prisma, 'admin@example.com', 'admin');
      const admin = await login(ctx, 'admin@example.com');
      const url = `/projects/${projectA}/activity`;

      const first = (await admin.get(`${url}?limit=4`).expect(200))
        .body as ActivityPage;
      expect(first.items).toHaveLength(4);
      expect(first.nextCursor).not.toBeNull();

      await store(
        stream.next('orchestrator.stopped', { reason: 'later' }),
        stream.next('orchestrator.started', { session: 'again' }),
      );
      await projector.tick();

      const seen = [...first.items];
      let cursor = first.nextCursor;
      while (cursor) {
        const page = (
          await admin.get(`${url}?limit=4&cursor=${cursor}`).expect(200)
        ).body as ActivityPage;
        seen.push(...page.items);
        cursor = page.nextCursor;
      }
      expect(seen.map((i) => i.type)).toEqual(
        curated()
          .map((e) => e.type)
          .reverse(),
      );
      expect(new Set(seen.map((i) => i.id)).size).toBe(10);

      await admin.get(`${url}?cursor=bm90LWEtY3Vyc29y`).expect(400);
    });
  });

  describe('retention (D6)', () => {
    it('deletes items older than the retention and leaves audit records alone', async () => {
      await store(stream.next('orchestrator.started', { session: 'a' }));
      await projector.tick();
      const auditBefore = await ctx.prisma.auditRecord.count();
      const old = await ctx.prisma.activityItem.create({
        data: {
          ts: new Date(Date.now() - 181 * DAY_MS),
          projectId: projectA,
          category: 'fleet',
          type: 'orchestrator.started',
          severity: 'ok',
          title: 'old',
          actorType: 'runner',
          data: {},
          sourceKind: 'event',
          sourceId: 999_999_999n,
        },
      });

      expect(await ctx.app.get(ActivityRetentionJob).sweep()).toBe(1);
      expect(
        await ctx.prisma.activityItem.findUnique({ where: { id: old.id } }),
      ).toBeNull();
      expect(
        await ctx.prisma.activityItem.count({ where: { sourceKind: 'event' } }),
      ).toBe(1);
      expect(await ctx.prisma.auditRecord.count()).toBe(auditBefore);
    });
  });
});
