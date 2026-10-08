import {
  eventsUnparsedData,
  type FleetView,
  normalizeCodeSentinelLine,
  type SlotDetail,
  type SlotPage,
} from '@agentdock/shared';
import {
  EVENTS_DUPLICATE_EVENT,
  type EventSource,
  type RunnerEvent,
} from '@agentdock/shared/protocol';
import {
  adminSession,
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
import { fleetRows, REPO, ROOT, seedProject } from './testing/fleet-e2e';

const DIR = `${ROOT}/.git/cs-orchestrator`;
const BOARD = `${DIR}/2026-10-08/round-1430.md`;
const BRIEF = `${DIR}/2026-10-08/round-1430-i42.md`;
const START = Date.parse('2026-10-08T14:30:00Z');
const at = (second: number) => new Date(START + second * 1000).toISOString();

/** A line of `events.jsonl` as plugin `emit.py` writes it (EVENTS.md). */
const line = (
  second: number,
  type: string,
  data: Record<string, unknown>,
  slot?: { slot: string; issue?: number },
): string =>
  JSON.stringify({
    v: 1,
    eid: `eid-${second}`,
    ts: at(second),
    type,
    source: 'code-sentinel',
    project: { repo: null, root: ROOT },
    ...(slot
      ? { ...slot, session: { runtime: 'claude', name: `cs-${slot.slot}` } }
      : {}),
    data,
  });

const i42 = { slot: 'i42', issue: 42 };

/** The fixture log: an orchestrator round that dispatches i42 (spec 16). */
const LOG = [
  line(1, 'orchestrator.started', {
    session: 'agentdock-46',
    config: { base: 'develop', maxSlots: 3 },
  }),
  line(2, 'round.started', {
    round: '1430',
    occupied: 1,
    max: 3,
    free: 2,
    board: BOARD,
  }),
  line(3, 'round.decided', {
    rows: [{ issue: 42, state: 'READY', why: 'spec ready' }],
  }),
  line(
    4,
    'slot.dispatched',
    {
      branch: 'feat/42-widget',
      worktree: '/srv/dev/.wt-widget-i42',
      model: 'opus',
      base: 'develop',
      brief: '/srv/dev/.wt-widget-i42/.orchestrator-brief.md',
      reusedWorktree: false,
      owns: ['apps/api/**'],
      never: ['apps/web/**'],
      modelWhy: 'defines the schema',
      lead: true,
    },
    i42,
  ),
  line(5, 'slot.checkpoint', { checkpoint: 'picked_up', summary: 'i42' }, i42),
  line(
    6,
    'slot.checkpoint',
    { checkpoint: 'plan_ready', summary: 'plan' },
    i42,
  ),
];

/** Spec 16 end to end: Code Sentinel events through a real runner socket. */
describe('fleet from events.jsonl (e2e)', () => {
  let ctx: RunnerE2eContext;
  let runnerId: string;
  let token: string;
  let projectId: string;
  let member: Session;
  let outsider: Session;
  let seq: number;
  const closers: (() => void)[] = [];

  /** What the runner's `events` collector sends for a line: `seq` added. */
  const read = (text: string): RunnerEvent => {
    const result = normalizeCodeSentinelLine(text, { repo: REPO, root: ROOT });
    if (!result.ok) throw new Error(result.reason);
    seq += 1;
    return { ...result.event, seq };
  };

  /** An event of the spec 11 collectors (markdown or tmux), at `second`. */
  const observed = (
    second: number,
    type: string,
    data: unknown,
    options: { slot?: string; issue?: number; source?: EventSource } = {},
  ): RunnerEvent => {
    seq += 1;
    return {
      v: 1,
      seq,
      ts: at(second),
      type,
      source: options.source ?? 'scraped',
      project: { repo: REPO, root: ROOT },
      ...(options.slot ? { slot: options.slot } : {}),
      ...(options.issue ? { issue: options.issue } : {}),
      data,
    };
  };

  const brief = (second: number, model: string) =>
    observed(
      second,
      'slot.dispatched',
      {
        date: '2026-10-08',
        round: '1430',
        briefPath: BRIEF,
        branch: 'feat/42-widget',
        model,
        modelWhy: 'scraped why',
        owns: ['apps/**'],
        never: [],
      },
      i42,
    );

  const reply = (second: number, checkpoint: string, position: number) =>
    observed(
      second,
      'slot.checkpoint',
      { checkpoint, heading: checkpoint.replace('_', ' '), position },
      { slot: 'i42' },
    );

  let socket: TestRunnerSocket;
  const send = async (events: RunnerEvent[]) => {
    socket.send({ type: 'events', events });
    const ack = await socket.next('ack');
    expect(ack.seq).toBe(events.at(-1)?.seq);
  };

  const fleet = async () =>
    (await member.get(`/projects/${projectId}/fleet`)).body as FleetView;
  const detail = async (name = 'i42') =>
    (await member.get(`/projects/${projectId}/slots/${name}`))
      .body as SlotDetail;
  const runs = (name = 'i42') =>
    ctx.prisma.slot.count({ where: { projectId, name } });

  beforeAll(async () => {
    ctx = await createRunnerE2eApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    const admin = await adminSession(ctx);
    ({ runnerId, token } = await pairedRunner(ctx, admin));
    ({ projectId } = await seedProject(ctx.prisma, ROOT, runnerId));
    const user = await createUser(ctx.prisma, 'member@example.com', 'viewer');
    await ctx.prisma.projectMember.create({
      data: { projectId, userId: user.id },
    });
    await createUser(ctx.prisma, 'outsider@example.com', 'viewer');
    member = await login(ctx, 'member@example.com');
    outsider = await login(ctx, 'outsider@example.com');
    seq = 0;
    socket = new TestRunnerSocket(ctx.origin, token);
    closers.push(() => socket.socket.terminate());
    await socket.connect(hello({ lastAckedSeq: 0 }));
  });
  afterEach(() => {
    for (const close of closers.splice(0)) close();
  });

  it('shows rounds, slots and checkpoints within 5 s of each appended line', async () => {
    expect((await fleet()).fleetChannel).toBe('scraped');
    for (const text of LOG) {
      const started = Date.now();
      await send([read(text)]);
      await fleet();
      expect(Date.now() - started).toBeLessThan(5_000);
    }

    const view = await fleet();
    expect(view.fleetChannel).toBe('events');
    expect(view.orchestrator).toMatchObject({
      status: 'running',
      session: 'agentdock-46',
    });
    expect(view.latestRound).toMatchObject({
      date: '2026-10-08',
      label: '1430',
      base: 'develop',
      occupied: 1,
      source: 'events',
    });
    const [round] = (await member.get(`/projects/${projectId}/rounds`))
      .body as { decisions: { dispatching: unknown[] } }[];
    expect(round.decisions.dispatching).toEqual([
      { Issue: '#42', State: 'READY', Why: 'spec ready' },
    ]);
    expect(await detail()).toMatchObject({
      name: 'i42',
      issue: 42,
      model: 'opus',
      modelWhy: 'defines the schema',
      lead: true,
      branch: 'feat/42-widget',
      worktree: '/srv/dev/.wt-widget-i42',
      owns: ['apps/api/**'],
      status: 'dispatched',
      lastCheckpoint: 'plan_ready',
      checkpoints: [
        { kind: 'picked_up', position: 0, summary: 'i42' },
        { kind: 'plan_ready', position: 1, summary: 'plan' },
      ],
    });
  });

  it('applies nothing twice when the file is read again from 0 (restart, truncation, new inode)', async () => {
    await send(LOG.map(read));
    const before = await fleetRows(ctx.prisma);

    // A re-read: the same lines, new seqs — and one twice in a batch.
    await send([...LOG, LOG[5]].map(read));
    expect(await fleetRows(ctx.prisma)).toEqual(before);
    expect(
      (await ctx.prisma.runner.findUniqueOrThrow({ where: { id: runnerId } }))
        .ackedSeq,
    ).toBe(BigInt(seq));
    expect(
      await ctx.prisma.event.count({ where: { pluginEventId: { not: null } } }),
    ).toBe(LOG.length);
    const duplicates = await ctx.prisma.event.findMany({
      where: { type: EVENTS_DUPLICATE_EVENT },
      orderBy: { seq: 'asc' },
      select: { data: true },
    });
    expect(duplicates).toHaveLength(LOG.length + 1);
    expect(duplicates[3].data).toEqual({
      pluginEventId: 'eid-4',
      type: 'slot.dispatched',
    });
    expect(await runs()).toBe(1);
  });

  it('keeps an unparsed line raw and applies the valid lines after it', async () => {
    const reasons = [
      '{"v":1,"type":',
      line(7, 'slot.checkpoint', {}, i42).replace('"v":1', '"v":99'),
    ].map((text) => {
      const result = normalizeCodeSentinelLine(text, {
        repo: REPO,
        root: ROOT,
      });
      return result.ok ? null : result.reason;
    });
    expect(reasons).toEqual([
      'malformed JSON',
      'unsupported schema version 99',
    ]);

    await send([
      ...reasons.map((reason, i) =>
        observed(
          i,
          'events.unparsed',
          eventsUnparsedData(
            `${DIR}/events.jsonl`,
            'raw',
            reason ?? '',
            i * 10,
          ),
          { source: 'runner' },
        ),
      ),
      ...LOG.slice(3).map(read),
    ]);
    expect(
      await ctx.prisma.event.count({ where: { type: 'events.unparsed' } }),
    ).toBe(2);
    expect((await detail()).checkpoints).toHaveLength(2);
  });

  it("shows the plugin's model over the brief's, and a later brief does not revert it", async () => {
    await send([brief(3, 'sonnet')]);
    expect((await detail()).model).toBe('sonnet');

    await send([read(LOG[3])]);
    expect(await detail()).toMatchObject({
      model: 'opus',
      modelWhy: 'defines the schema',
      owns: ['apps/api/**'],
    });

    // The board collector reads the brief again.
    await send([brief(10, 'sonnet')]);
    expect(await detail()).toMatchObject({
      model: 'opus',
      round: '2026-10-08/1430',
    });
    expect(await runs()).toBe(1);
  });

  it('keeps one run when the plugin dispatch comes before the brief', async () => {
    await send([read(LOG[3]), brief(8, 'sonnet')]);
    expect(await runs()).toBe(1);
    expect(await detail()).toMatchObject({
      model: 'opus',
      round: '2026-10-08/1430',
    });
  });

  it('lands a plugin checkpoint on the heading the reply collector saw, either order', async () => {
    await send([read(LOG[3]), reply(5, 'picked_up', 0)]);
    await send([read(LOG[4]), read(LOG[5])]);
    // The reply collector reaches plan_ready after the plugin did.
    await send([reply(7, 'plan_ready', 1), reply(8, 'picked_up', 0)]);
    expect((await detail()).checkpoints).toMatchObject([
      { position: 0, kind: 'picked_up', heading: 'picked up', summary: 'i42' },
      { position: 1, kind: 'plan_ready', summary: 'plan' },
    ]);
  });

  it('is on both channels while a live slot still carries a field from markdown', async () => {
    await send([
      read(LOG[0]),
      observed(
        3,
        'slot.dispatched',
        {
          date: '2026-10-08',
          round: '1430',
          briefPath: `${DIR}/2026-10-08/round-1430-i43.md`,
          model: 'sonnet',
        },
        { slot: 'i43', issue: 43 },
      ),
    ]);
    expect((await fleet()).fleetChannel).toBe('both');

    await send([
      read(
        line(
          9,
          'slot.dispatched',
          {
            branch: 'b',
            worktree: '/w',
            model: 'opus',
            base: 'develop',
            brief: '/w/b',
          },
          { slot: 'i43', issue: 43 },
        ),
      ),
    ]);
    expect((await fleet()).fleetChannel).toBe('events');
  });

  it("keeps the plugin's round header and decisions over the board's, but takes the board's base", async () => {
    await send(LOG.slice(1, 3).map(read));
    await send([
      observed(10, 'round.started', {
        date: '2026-10-08',
        round: '1430',
        base: 'main',
        occupied: 3,
        max: 3,
        free: 0,
        boardPath: BOARD,
      }),
      observed(11, 'round.decided', {
        date: '2026-10-08',
        round: '1430',
        decisions: { dispatching: [], inFlight: [{ Issue: '#9' }] },
      }),
    ]);
    const [round] = (await member.get(`/projects/${projectId}/rounds`))
      .body as {
      base: string;
      occupied: number;
      source: string;
      decisions: { dispatching: unknown[] };
    }[];
    expect(round).toMatchObject({
      base: 'main',
      occupied: 1,
      source: 'events',
    });
    expect(round.decisions.dispatching).toHaveLength(1);
    expect((await fleet()).fleetChannel).toBe('events');
  });

  it('upserts every slot a snapshot lists, and a replay from 0 does not fork its runs', async () => {
    const snapshot = observed(
      20,
      'orchestrator.snapshot',
      {
        state: {
          v: 1,
          updatedAt: at(20),
          repo: REPO,
          slots: {
            i42: {
              issue: 42,
              branch: 'feat/42-widget',
              worktree: '/srv/dev/.wt-widget-i42',
              model: 'opus',
              modelWhy: 'defines the schema',
              status: 'running',
              lastCheckpoint: {
                checkpoint: 'plan_ready',
                ts: at(6),
                summary: '',
              },
              pr: null,
              dispatchedAt: at(4),
              endedAt: null,
            },
            i43: {
              issue: 43,
              branch: 'feat/43',
              model: 'sonnet',
              status: 'pr_open',
              lastCheckpoint: { checkpoint: 'pr_open', ts: at(9) },
              pr: {
                number: 51,
                rollup: 'green',
                url: 'https://github.com/acme/widget/pull/51',
              },
              dispatchedAt: at(8),
              endedAt: null,
            },
            i40: {
              issue: 40,
              model: 'opus',
              status: 'merged',
              dispatchedAt: at(0),
              endedAt: at(2),
            },
          },
          personNeeded: [],
        },
      },
      { source: 'code-sentinel' },
    );
    await send([snapshot]);
    const listed = (await fleet()).slots.map((s) => [
      s.name,
      s.model,
      s.lastCheckpoint,
      s.prNumber,
      s.prChecks,
    ]);
    expect(listed.sort()).toEqual([
      ['i42', 'opus', 'plan_ready', null, null],
      ['i43', 'sonnet', 'pr_open', 51, 'green'],
    ]);
    expect(await runs('i40')).toBe(0);
    expect((await detail('i42')).startedAt).toBe(at(4));

    // First connection: the collector reads events.jsonl from offset 0.
    await send(LOG.map(read));
    expect(await runs()).toBe(1);
    expect((await detail()).checkpoints).toHaveLength(2);
  });

  it('returns fleetChannel only on /fleet, which a non-member cannot read', async () => {
    await send([read(LOG[3])]);
    expect((await outsider.get(`/projects/${projectId}/fleet`)).status).toBe(
      404,
    );
    const page = (await member.get(`/projects/${projectId}/slots`))
      .body as SlotPage;
    expect(page.items[0]).not.toHaveProperty('fleetChannel');
    expect(await detail()).not.toHaveProperty('fleetChannel');
  });
});
