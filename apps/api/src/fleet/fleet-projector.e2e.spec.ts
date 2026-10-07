import type { RunnerEvent } from '@agentdock/shared/protocol';
import { createE2eApp, type E2eContext, resetDatabase } from '../test/e2e-app';
import { FleetProjector } from './fleet-projector.service';
import { EventStream, fleetRows, ROOT, seedProject } from './testing/fleet-e2e';

const BOARD = `${ROOT}/.git/cs-orchestrator/2026-10-08/round-1430.md`;
const BRIEF = `${ROOT}/.git/cs-orchestrator/2026-10-08/round-1430-i42.md`;
const PR_URL = 'https://github.com/acme/widget/pull/7';

describe('fleet projector (e2e)', () => {
  let ctx: E2eContext;
  let projector: FleetProjector;
  let runnerId: string;
  let projectId: string;
  let stream: EventStream;

  const project = (...events: RunnerEvent[]) =>
    projector.project(runnerId, events);

  const slot = (name = 'i42') =>
    ctx.prisma.slot.findFirstOrThrow({
      where: { projectId, name },
      orderBy: { startedAt: 'desc' },
    });

  const brief = (round = '1430', extra: Record<string, unknown> = {}) =>
    stream.next(
      'slot.dispatched',
      {
        date: '2026-10-08',
        round,
        briefPath: BRIEF,
        branch: 'feat/42-widget',
        worktree: '/srv/dev/.wt-widget-i42',
        model: 'opus',
        modelWhy: 'defines the schema',
        owns: ['apps/api/src/widget/**'],
        never: ['apps/web/**'],
        lead: true,
        ...extra,
      },
      { slot: 'i42', issue: 42, source: 'scraped' },
    );

  const appeared = (name = 'i42') =>
    stream.next('session.appeared', { name: `cs-${name}` }, { slot: name });
  const vanished = (name = 'i42') =>
    stream.next('session.vanished', { name: `cs-${name}` }, { slot: name });
  const worktree = (data: Record<string, unknown>) =>
    stream.next(
      'worktree.changed',
      { path: '/srv/dev/.wt-widget-i42', ...data },
      { slot: 'i42' },
    );

  beforeAll(async () => {
    ctx = await createE2eApp();
    projector = ctx.app.get(FleetProjector);
  });
  afterAll(() => ctx.app.close());
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ({ runnerId, projectId } = await seedProject(ctx.prisma));
    stream = new EventStream();
  });

  it('lists a slot as running, then stale when its session dies with unmerged work', async () => {
    await project(
      appeared(),
      worktree({
        exists: true,
        branch: 'feat/42',
        ahead: 0,
        behind: 0,
        dirty: false,
      }),
    );
    expect(await slot()).toMatchObject({
      status: 'running',
      worktree: '/srv/dev/.wt-widget-i42',
      branch: 'feat/42',
    });

    await project(
      worktree({ exists: true, ahead: 1, behind: 0, dirty: false }),
    );
    const vanish = vanished();
    await project(vanish);
    expect(await slot()).toMatchObject({
      status: 'stale',
      ahead: 1,
      endedAt: null,
    });
  });

  it('ends a slot when its PR merges, or when its worktree is gone', async () => {
    await project(appeared(), vanished());
    const merged = stream.next(
      'pr.closed',
      { number: 7, branch: 'feat/42', merged: true },
      { slot: 'i42' },
    );
    await project(merged);
    expect(await slot()).toMatchObject({
      status: 'ended',
      prState: 'merged',
      endedAt: new Date(merged.ts),
    });

    await project(appeared('i43'), vanished('i43'));
    expect((await slot('i43')).status).toBe('stale');
    const gone = stream.next(
      'worktree.changed',
      { path: '/srv/dev/.wt-widget-i43', exists: false },
      { slot: 'i43' },
    );
    await project(gone);
    expect(await slot('i43')).toMatchObject({
      status: 'ended',
      worktreeExists: false,
      endedAt: new Date(gone.ts),
    });
  });

  it('follows the pane through prompt, idle, quota and busy', async () => {
    await project(appeared());
    const pane = (type: string, data: Record<string, unknown> = {}) =>
      stream.next(type, data, { slot: 'i42' });

    await project(pane('pane.prompt', { dialog: 'trust' }));
    expect((await slot()).status).toBe('prompt');
    await project(pane('pane.busy'));
    expect((await slot()).status).toBe('running');
    await project(pane('pane.idle', { polls: 3 }));
    expect((await slot()).status).toBe('idle');
    await project(pane('pane.quota_hit'));
    expect((await slot()).status).toBe('quota');
    await project(vanished());
    expect(await slot()).toMatchObject({ status: 'stale', pane: null });
  });

  it('takes the brief: dispatched until the session appears, on the same run', async () => {
    await project(brief());
    const first = await slot();
    expect(first).toMatchObject({
      status: 'dispatched',
      issue: 42,
      round: '2026-10-08/1430',
      model: 'opus',
      modelWhy: 'defines the schema',
      owns: ['apps/api/src/widget/**'],
      never: ['apps/web/**'],
      lead: true,
      branch: 'feat/42-widget',
    });

    await project(appeared());
    const second = await slot();
    expect(second.id).toBe(first.id);
    expect(second.status).toBe('running');
  });

  it('starts a new run for a new session or a new brief after the slot ended, never for an old brief', async () => {
    await project(brief(), appeared(), vanished());
    await project(worktree({ exists: false }));
    const ended = await slot();
    expect(ended.status).toBe('ended');

    // A runner restart rescans the same brief: same run, still ended.
    await project(brief());
    expect(await ctx.prisma.slot.count({ where: { name: 'i42' } })).toBe(1);

    await project(appeared());
    const rerun = await slot();
    expect(rerun.id).not.toBe(ended.id);
    expect(rerun.status).toBe('running');

    // The old brief rescanned again still belongs to the first run.
    await project(brief());
    expect(await ctx.prisma.slot.count({ where: { name: 'i42' } })).toBe(2);
    expect((await slot()).id).toBe(rerun.id);
  });

  it('creates checkpoints in order and sets lastCheckpoint and prUrl', async () => {
    await project(appeared());
    const checkpoint = (position: number, heading: string, kind: string) =>
      stream.next(
        'slot.checkpoint',
        {
          checkpoint: kind,
          heading,
          summary: `body ${position}`,
          position,
          ...(kind === 'pr_open' ? { prUrl: PR_URL } : {}),
        },
        { slot: 'i42', source: 'scraped' },
      );

    await project(checkpoint(0, 'plan ready', 'plan_ready'));
    await project(checkpoint(1, `pull request open — ${PR_URL}`, 'pr_open'));
    // A rescan re-emits both with later timestamps: nothing new.
    await project(
      checkpoint(0, 'plan ready', 'plan_ready'),
      checkpoint(1, `pull request open — ${PR_URL}`, 'pr_open'),
    );

    const row = await slot();
    expect(row).toMatchObject({ lastCheckpoint: 'pr_open', prUrl: PR_URL });
    const checkpoints = await ctx.prisma.slotCheckpoint.findMany({
      where: { slotId: row.id },
      orderBy: { position: 'asc' },
    });
    expect(checkpoints.map((c) => [c.position, c.kind])).toEqual([
      [0, 'plan_ready'],
      [1, 'pr_open'],
    ]);
    expect(checkpoints[0].at < checkpoints[1].at).toBe(true);
  });

  it('flips prChecks from pending to green, and to red on one failure', async () => {
    await project(
      appeared(),
      worktree({
        exists: true,
        branch: 'feat/42',
        ahead: 1,
        behind: 0,
        dirty: false,
      }),
    );
    // No envelope slot: the PR collector matched nothing, the branch does.
    await project(
      stream.next('pr.opened', {
        number: 7,
        branch: 'feat/42',
        url: PR_URL,
        title: 'feat: widget',
        checks: 'pending',
        mergeable: true,
      }),
    );
    expect(await slot()).toMatchObject({
      prNumber: 7,
      prUrl: PR_URL,
      prState: 'open',
      prChecks: 'pending',
      prMergeable: true,
    });

    const checks = (value: string) =>
      stream.next(
        'pr.checks_changed',
        { number: 7, branch: 'feat/42', checks: value },
        { slot: 'i42' },
      );
    await project(checks('green'));
    expect((await slot()).prChecks).toBe('green');
    await project(checks('red'));
    expect((await slot()).prChecks).toBe('red');
  });

  it('tracks the orchestrator: running, idle, absent', async () => {
    const orchestrator = () =>
      ctx.prisma.fleetOrchestrator.findUniqueOrThrow({ where: { projectId } });
    const started = stream.next('orchestrator.started', {
      session: 'agentdock-orchestrator',
    });
    await project(started);
    expect(await orchestrator()).toMatchObject({
      status: 'running',
      session: 'agentdock-orchestrator',
      since: new Date(started.ts),
    });

    await project(
      stream.next('pane.idle', { target: 'orchestrator', polls: 3 }),
    );
    expect((await orchestrator()).status).toBe('idle');
    await project(stream.next('pane.busy', { target: 'orchestrator' }));
    expect((await orchestrator()).status).toBe('running');

    await project(
      stream.next('orchestrator.stopped', {
        session: 'agentdock-orchestrator',
      }),
    );
    expect((await orchestrator()).status).toBe('absent');
    // A late pane poll does not bring it back.
    await project(stream.next('pane.busy', { target: 'orchestrator' }));
    expect((await orchestrator()).status).toBe('absent');
  });

  it('projects a round, keeps a board error until the next round parses', async () => {
    const header = (round: string) =>
      stream.next(
        'round.started',
        {
          date: '2026-10-08',
          round,
          base: 'develop',
          occupied: 2,
          max: 3,
          free: 1,
          boardPath: BOARD,
        },
        { source: 'scraped' },
      );
    const decisions = {
      dispatching: [
        { Issue: '#42', Slot: 'i42', Model: 'opus', Extra: 'kept' },
      ],
      heldForLead: [],
      notDispatching: [{ Issue: '#50', Why: 'blocked by #42' }],
      inFlight: [{ Slot: 'i41', PR: '#6' }],
    };
    await project(
      header('1430'),
      stream.next(
        'round.decided',
        { date: '2026-10-08', round: '1430', decisions },
        { source: 'scraped' },
      ),
    );
    const round = await ctx.prisma.round.findFirstOrThrow({
      where: { projectId },
    });
    expect(round).toMatchObject({
      label: '1430',
      base: 'develop',
      occupied: 2,
      max: 3,
      free: 1,
      source: 'scraped',
      boardPath: BOARD,
      decisions,
    });

    await project(
      stream.next(
        'board.unparsed',
        { file: BOARD, line: 4, reason: 'no header line' },
        { source: 'scraped' },
      ),
    );
    expect(
      (
        await ctx.prisma.fleetOrchestrator.findUniqueOrThrow({
          where: { projectId },
        })
      ).boardError,
    ).toMatchObject({ file: BOARD, line: 4, reason: 'no header line' });
    // A board error alone says nothing about the orchestrator.
    expect(
      (
        await ctx.prisma.fleetOrchestrator.findUniqueOrThrow({
          where: { projectId },
        })
      ).status,
    ).toBeNull();

    await project(header('1500'));
    expect(
      (
        await ctx.prisma.fleetOrchestrator.findUniqueOrThrow({
          where: { projectId },
        })
      ).boardError,
    ).toBeNull();
  });

  it('gives identical rows when the same events are replayed', async () => {
    const events = [
      stream.next('orchestrator.started', {
        session: 'agentdock-orchestrator',
      }),
      stream.next(
        'round.started',
        {
          date: '2026-10-08',
          round: '1430',
          base: 'develop',
          occupied: 1,
          max: 3,
          free: 2,
          boardPath: BOARD,
        },
        { source: 'scraped' },
      ),
      stream.next(
        'round.decided',
        {
          date: '2026-10-08',
          round: '1430',
          decisions: { dispatching: [{ Issue: '#42' }] },
        },
        { source: 'scraped' },
      ),
      brief(),
      appeared(),
      worktree({
        exists: true,
        branch: 'feat/42-widget',
        ahead: 2,
        behind: 0,
        dirty: true,
      }),
      stream.next('pane.idle', { polls: 3 }, { slot: 'i42' }),
      stream.next(
        'slot.checkpoint',
        {
          checkpoint: 'plan_ready',
          heading: 'plan ready',
          summary: 'x',
          position: 0,
        },
        { slot: 'i42', source: 'scraped' },
      ),
      stream.next('pr.opened', {
        number: 7,
        branch: 'feat/42-widget',
        url: PR_URL,
        title: 't',
        checks: 'pending',
      }),
      vanished(),
      stream.next(
        'pr.closed',
        { number: 7, branch: 'feat/42-widget', merged: true },
        { slot: 'i42' },
      ),
      appeared(),
      stream.next(
        'board.unparsed',
        { file: BRIEF, reason: 'no Model line' },
        { source: 'scraped' },
      ),
      stream.next('orchestrator.stopped', {
        session: 'agentdock-orchestrator',
      }),
    ];
    await project(...events);
    const once = await fleetRows(ctx.prisma);
    expect(once.slots).toHaveLength(2);

    await project(...events);
    // One at a time too, as a resend after a reconnect would deliver them.
    for (const event of events) await project(event);
    expect(await fleetRows(ctx.prisma)).toEqual(once);
  });

  it('skips malformed data and unknown projects, and applies the rest', async () => {
    const changes = await project(
      stream.next('pane.idle', { polls: 'three' }, { slot: 'i42' }),
      stream.next('session.appeared', { name: 'cs-i42' }),
      appeared('i42'),
      stream.next(
        'session.appeared',
        { name: 'cs-i9' },
        { slot: 'i9', root: '/srv/dev/elsewhere' },
      ),
      stream.next('llm.request', { model: 'x' }),
    );
    expect(await ctx.prisma.slot.count()).toBe(1);
    expect(changes).toEqual([
      { projectId, kind: 'slot', id: (await slot()).id },
    ]);
  });
});
