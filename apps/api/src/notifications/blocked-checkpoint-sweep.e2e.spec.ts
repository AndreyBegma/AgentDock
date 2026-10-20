import type { RunnerEvent } from '@nautelle/shared/protocol';
import { FleetProjector } from '../fleet/fleet-projector.service';
import { EventStream } from '../fleet/testing/fleet-e2e';
import { BlockedCheckpointSweep } from './blocked-checkpoint-sweep';
import {
  createNotificationsApp,
  type NotificationsE2e,
  ROOT,
  resetNotifications,
  seedRunnerProject,
  seedUser,
} from './testing/notifications-e2e';

const START = Date.parse('2026-10-08T10:00:00Z');
/**
 * `m` minutes after the stream's start; its events are a few seconds later,
 * so a checkpoint is 15 min old at `at(16)`, not yet at `at(15)`.
 */
const at = (m: number) => new Date(START + m * 60_000);

describe('blocked checkpoint sweep (e2e)', () => {
  let ctx: NotificationsE2e;
  let sweep: BlockedCheckpointSweep;
  let projector: FleetProjector;
  let runnerId: string;
  let projectId: string;
  let stream: EventStream;
  let admin: { id: string };

  const project = (...events: RunnerEvent[]) =>
    projector.project(runnerId, events);

  const dispatched = () =>
    stream.next(
      'slot.dispatched',
      {
        date: '2026-10-08',
        round: '0959',
        briefPath: `${ROOT}/.git/cs-orchestrator/2026-10-08/round-0959-i42.md`,
        branch: 'fix/42-widget',
        worktree: '/srv/dev/.wt-widget-i42',
        model: 'opus',
        owns: ['apps/api/src/widget/**'],
        never: [],
      },
      { slot: 'i42', issue: 42, source: 'scraped' },
    );

  /** What `ReplyWatcher` emits for the section at `position`. */
  const checkpoint = (
    position: number,
    heading: string,
    summary = 'one docs question only; everything else proceeding',
  ) =>
    stream.next(
      'slot.checkpoint',
      {
        checkpoint: heading.startsWith('blocked') ? 'blocked' : 'plan_ready',
        heading,
        summary,
        position,
      },
      { slot: 'i42', issue: 42, source: 'scraped' },
    );

  const notified = () =>
    ctx.prisma.notification.findMany({
      where: { userId: admin.id, kind: 'slot.blocked' },
      orderBy: { id: 'asc' },
    });

  beforeAll(async () => {
    ctx = await createNotificationsApp();
    sweep = ctx.app.get(BlockedCheckpointSweep);
    projector = ctx.app.get(FleetProjector);
  });
  afterAll(() => ctx.app.close());

  beforeEach(async () => {
    await resetNotifications(ctx.prisma);
    ({ runnerId, projectId } = await seedRunnerProject(ctx.prisma));
    admin = await seedUser(ctx.prisma, 'ada@example.com', 'admin');
    stream = new EventStream(START);
    await project(dispatched());
  });

  it('notifies once, with the heading, when the checkpoint still stands after 15 min', async () => {
    await ctx.prisma.telegramLink.create({
      data: { userId: admin.id, chatId: 1n },
    });
    await project(checkpoint(0, 'blocked — which docs repository?'));

    expect(await sweep.tick(at(1))).toBe(true);
    expect(await sweep.tick(at(15))).toBe(true);
    expect(await notified()).toEqual([]);

    expect(await sweep.tick(at(16))).toBe(true);
    expect(await sweep.tick(at(17))).toBe(true);
    expect(await sweep.tick(at(90))).toBe(true);

    const rows = await notified();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId,
      runnerId,
      slot: 'i42',
      issue: 42,
      title: 'i42 (#42) is blocked',
      body: 'blocked — which docs repository?',
      link: `/projects/${projectId}/fleet`,
      count: 1,
    });
    expect(
      await ctx.prisma.notificationDelivery.count({
        where: { notificationId: rows[0].id, status: 'pending' },
      }),
    ).toBe(1);
  });

  it('does not notify again for a re-emitted position or an edited body', async () => {
    await project(checkpoint(0, 'blocked'));
    await sweep.tick(at(16));
    expect(await notified()).toHaveLength(1);

    // A runner restart re-emits the whole reply file; the worker edits the body.
    await project(checkpoint(0, 'blocked'));
    await project(
      checkpoint(0, 'blocked', 'an edited body under the same heading'),
    );
    await sweep.tick(at(16));
    await sweep.tick(at(60));

    const rows = await notified();
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe('The worker reported a blocked checkpoint.');
  });

  it('does not notify for a checkpoint superseded within 15 min', async () => {
    await project(checkpoint(0, 'blocked — a question for the orchestrator'));
    await sweep.tick(at(5));
    // The orchestrator answered; the worker moved on.
    await project(checkpoint(1, 'plan ready'));

    await sweep.tick(at(16));
    await sweep.tick(at(60));
    expect(await notified()).toEqual([]);
  });

  it('does not notify once the slot has ended', async () => {
    await project(checkpoint(0, 'blocked'));
    await ctx.prisma.slot.updateMany({
      where: { projectId },
      data: { status: 'ended', endedAt: at(10) },
    });

    await sweep.tick(at(16));
    expect(await notified()).toEqual([]);
  });

  it('counts a new heading at the same position as a new checkpoint, standing from when it is seen', async () => {
    await project(checkpoint(0, 'blocked — first question'));
    await sweep.tick(at(16));
    expect(await notified()).toHaveLength(1);

    // The reply file started over: position 0 now carries another heading.
    await project(checkpoint(0, 'blocked — second question'));
    await sweep.tick(at(20));
    await sweep.tick(at(34));
    expect(await notified()).toHaveLength(1);

    await sweep.tick(at(35));
    await sweep.tick(at(40));
    expect((await notified()).map((n) => n.body)).toEqual([
      'blocked — first question',
      'blocked — second question',
    ]);
  });

  it('notifies nothing for checkpoints that existed before the sweep (backfilled as notified)', async () => {
    await project(checkpoint(0, 'blocked'));
    const [row] = await ctx.prisma.slotCheckpoint.findMany();
    await ctx.prisma.blockedCheckpointNotice.create({
      data: {
        checkpointId: row.id,
        heading: row.heading,
        since: row.at,
        notifiedAt: at(1),
      },
    });

    await sweep.tick(at(60));
    expect(await notified()).toEqual([]);
  });

  it('skips the pass while another holds the lock', async () => {
    await project(checkpoint(0, 'blocked'));
    await ctx.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext('notifications:blocked')) AS locked`;
      expect(await sweep.tick(at(16))).toBe(false);
    });
    expect(await notified()).toEqual([]);

    expect(await sweep.tick(at(16))).toBe(true);
    expect(await notified()).toHaveLength(1);
  });
});
