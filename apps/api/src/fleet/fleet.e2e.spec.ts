import {
  FLEET_LIVE_EVENT,
  type FleetView,
  type RoundView,
  type SlotDetail,
  type SlotPage,
} from '@agentdock/shared';
import type { RunnerEvent } from '@agentdock/shared/protocol';
import { allowedLiveOrigin } from '../live/live-options';
import {
  createLiveE2eApp,
  type LiveE2eContext,
  TestLiveSocket,
} from '../live/testing/live-e2e';
import {
  createUser,
  login,
  resetDatabase,
  type Session,
} from '../test/e2e-app';
import { FleetProjector } from './fleet-projector.service';
import { EventStream, ROOT, seedProject } from './testing/fleet-e2e';

const OTHER_ROOT = '/srv/dev/gadget';
const PR_URL = 'https://github.com/acme/widget/pull/7';

describe('fleet routes (e2e)', () => {
  let ctx: LiveE2eContext;
  let projector: FleetProjector;
  let runnerId: string;
  let a: string;
  let b: string;
  let memberOfA: Session;
  let memberOfB: Session;
  let stream: EventStream;
  const sockets: TestLiveSocket[] = [];

  const routes = (projectId: string) => [
    `/projects/${projectId}/fleet`,
    `/projects/${projectId}/slots`,
    `/projects/${projectId}/slots/i42`,
    `/projects/${projectId}/rounds`,
  ];

  const viewerOf = async (email: string, projectId: string) => {
    const user = await createUser(ctx.prisma, email, 'viewer');
    await ctx.prisma.projectMember.create({
      data: { projectId, userId: user.id },
    });
    return login(ctx, email);
  };

  const project = (...events: RunnerEvent[]) =>
    projector.handle(runnerId, events);

  beforeAll(async () => {
    ctx = await createLiveE2eApp();
    projector = ctx.app.get(FleetProjector);
  });
  afterAll(async () => {
    for (const socket of sockets) socket.socket.close();
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ({ runnerId, projectId: a } = await seedProject(ctx.prisma));
    ({ projectId: b } = await seedProject(ctx.prisma, OTHER_ROOT, runnerId));
    memberOfA = await viewerOf('a@example.com', a);
    memberOfB = await viewerOf('b@example.com', b);
    stream = new EventStream();
  });

  describe('authorization', () => {
    it('answers 404 on every route of a project the caller is not a member of', async () => {
      for (const path of routes(a)) {
        const response = await memberOfB.get(path);
        expect([path, response.status]).toEqual([path, 404]);
        expect(response.body.error).toBe('not_found');
      }
    });

    it('answers 401 to an anonymous caller', async () => {
      for (const path of routes(a)) {
        const response = await ctx.http().get(path);
        expect([path, response.status]).toEqual([path, 401]);
      }
    });

    it('lets a member of the project read', async () => {
      for (const path of routes(a).filter((p) => !p.endsWith('/i42'))) {
        expect((await memberOfA.get(path)).status).toBe(200);
      }
    });
  });

  it('serves the fleet: orchestrator, latest round, live slots only', async () => {
    const empty = (await memberOfA.get(`/projects/${a}/fleet`))
      .body as FleetView;
    expect(empty).toEqual({
      projectId: a,
      orchestrator: { status: 'unknown', session: null, since: null },
      base: 'develop',
      latestRound: null,
      boardError: null,
      slots: [],
    });

    await project(
      stream.next('orchestrator.started', {
        session: 'agentdock-orchestrator',
      }),
      stream.next(
        'round.started',
        {
          date: '2026-10-08',
          round: '1430',
          base: 'main',
          occupied: 1,
          max: 3,
          free: 2,
          boardPath: `${ROOT}/.git/cs-orchestrator/2026-10-08/round-1430.md`,
        },
        { source: 'scraped' },
      ),
      stream.next(
        'session.appeared',
        { name: 'cs-i42' },
        { slot: 'i42', issue: 42 },
      ),
      stream.next('session.appeared', { name: 'cs-i41' }, { slot: 'i41' }),
      stream.next(
        'worktree.changed',
        { path: '/srv/dev/.wt-widget-i41', exists: false },
        { slot: 'i41' },
      ),
      stream.next('session.vanished', { name: 'cs-i41' }, { slot: 'i41' }),
    );

    const fleet = (await memberOfA.get(`/projects/${a}/fleet`))
      .body as FleetView;
    expect(fleet.orchestrator).toMatchObject({
      status: 'running',
      session: 'agentdock-orchestrator',
    });
    expect(fleet.base).toBe('main');
    expect(fleet.latestRound).toMatchObject({
      date: '2026-10-08',
      label: '1430',
      occupied: 1,
      max: 3,
      free: 2,
      source: 'scraped',
    });
    expect(fleet.slots.map((s) => [s.name, s.status, s.issue])).toEqual([
      ['i42', 'running', 42],
    ]);

    // Project B sees none of it.
    const other = (await memberOfB.get(`/projects/${b}/fleet`))
      .body as FleetView;
    expect(other.slots).toEqual([]);
    expect(other.orchestrator.status).toBe('unknown');
  });

  it('pages slots newest first and filters them', async () => {
    for (const name of ['i1', 'i2', 'i3']) {
      await project(
        stream.next(
          'session.appeared',
          { name: `cs-${name}` },
          {
            slot: name,
            issue: Number(name.slice(1)),
          },
        ),
      );
    }
    await project(
      stream.next('session.vanished', { name: 'cs-i1' }, { slot: 'i1' }),
    );

    const first = (await memberOfA.get(`/projects/${a}/slots?limit=2`))
      .body as SlotPage;
    expect(first.items.map((s) => s.name)).toEqual(['i3', 'i2']);
    expect(first.nextCursor).not.toBeNull();
    const second = (
      await memberOfA.get(
        `/projects/${a}/slots?limit=2&cursor=${first.nextCursor}`,
      )
    ).body as SlotPage;
    expect(second).toMatchObject({ nextCursor: null });
    expect(second.items.map((s) => s.name)).toEqual(['i1']);

    const stale = (await memberOfA.get(`/projects/${a}/slots?status=stale`))
      .body as SlotPage;
    expect(stale.items.map((s) => s.name)).toEqual(['i1']);
    const byIssue = (await memberOfA.get(`/projects/${a}/slots?issue=2`))
      .body as SlotPage;
    expect(byIssue.items.map((s) => s.name)).toEqual(['i2']);

    expect(
      (await memberOfA.get(`/projects/${a}/slots?status=lost`)).status,
    ).toBe(400);
    expect((await memberOfA.get(`/projects/${a}/slots?limit=0`)).status).toBe(
      400,
    );
  });

  it('serves a slot with its brief, fence and checkpoints', async () => {
    await project(
      stream.next(
        'slot.dispatched',
        {
          date: '2026-10-08',
          round: '1430',
          briefPath: `${ROOT}/.git/cs-orchestrator/2026-10-08/round-1430-i42.md`,
          model: 'opus',
          modelWhy: 'schema work',
          owns: ['apps/api/**'],
          never: ['apps/web/**'],
        },
        { slot: 'i42', issue: 42, source: 'scraped' },
      ),
      stream.next('session.appeared', { name: 'cs-i42' }, { slot: 'i42' }),
      stream.next(
        'slot.checkpoint',
        {
          checkpoint: 'plan_ready',
          heading: 'plan ready',
          summary: 'the plan',
          position: 0,
        },
        { slot: 'i42', source: 'scraped' },
      ),
      stream.next(
        'slot.checkpoint',
        {
          checkpoint: 'pr_open',
          heading: `pull request open — ${PR_URL}`,
          summary: '',
          position: 1,
          prUrl: PR_URL,
        },
        { slot: 'i42', source: 'scraped' },
      ),
    );

    const response = await memberOfA.get(`/projects/${a}/slots/i42`);
    expect(response.status).toBe(200);
    const detail = response.body as SlotDetail;
    expect(detail).toMatchObject({
      name: 'i42',
      issue: 42,
      status: 'running',
      model: 'opus',
      modelWhy: 'schema work',
      owns: ['apps/api/**'],
      never: ['apps/web/**'],
      round: '2026-10-08/1430',
      worktree: '/srv/dev/.wt-widget-i42',
      lastCheckpoint: 'pr_open',
      prUrl: PR_URL,
      sessionAlive: true,
    });
    expect(detail.checkpoints.map((c) => c.kind)).toEqual([
      'plan_ready',
      'pr_open',
    ]);

    const missing = await memberOfA.get(`/projects/${a}/slots/i99`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('slot_not_found');
  });

  it('lists rounds with decisions, filtered by date', async () => {
    const round = (date: string, label: string) => [
      stream.next(
        'round.started',
        {
          date,
          round: label,
          base: 'develop',
          occupied: 0,
          max: 2,
          free: 2,
          boardPath: `${ROOT}/.git/cs-orchestrator/${date}/round-${label}.md`,
        },
        { source: 'scraped' },
      ),
      stream.next(
        'round.decided',
        {
          date,
          round: label,
          decisions: { dispatching: [{ Issue: `#${label}` }] },
        },
        { source: 'scraped' },
      ),
    ];
    await project(
      ...round('2026-10-07', '0900'),
      ...round('2026-10-08', '1430'),
    );

    const all = (await memberOfA.get(`/projects/${a}/rounds`))
      .body as RoundView[];
    expect(all.map((r) => [r.date, r.label])).toEqual([
      ['2026-10-08', '1430'],
      ['2026-10-07', '0900'],
    ]);
    expect(all[0].decisions).toEqual({
      dispatching: [{ Issue: '#1430' }],
      heldForLead: [],
      notDispatching: [],
      inFlight: [],
    });
    const one = (await memberOfA.get(`/projects/${a}/rounds?date=2026-10-07`))
      .body as RoundView[];
    expect(one.map((r) => r.label)).toEqual(['0900']);
    expect(
      (await memberOfA.get(`/projects/${a}/rounds?date=yesterday`)).status,
    ).toBe(400);
  });

  it('pushes projection changes to the project topic', async () => {
    const live = new TestLiveSocket(ctx.liveUrl, {
      token: memberOfA.token,
      origin: allowedLiveOrigin(),
    });
    sockets.push(live);
    await live.ready();
    expect((await live.subscribe(`project:${a}`)).type).toBe('subscribed');

    const started = Date.now();
    await project(
      stream.next('session.appeared', { name: 'cs-i42' }, { slot: 'i42' }),
    );
    const frame = await live.next('event', 5_000);
    expect(Date.now() - started).toBeLessThan(5_000);
    const slot = await ctx.prisma.slot.findFirstOrThrow({
      where: { projectId: a },
    });
    expect(frame).toMatchObject({
      topic: `project:${a}`,
      event: FLEET_LIVE_EVENT,
      data: { kind: 'slot', id: slot.id },
    });
  });
});
