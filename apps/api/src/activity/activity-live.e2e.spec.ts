import {
  ACTIVITY_ITEM_LIVE_EVENT,
  type ActivityItem,
  RUN_UPDATED_LIVE_EVENT,
  type RunLiveChange,
} from '@agentdock/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../app.module';
import { configureApp } from '../configure-app';
import { PrismaService } from '../database/prisma.service';
import { EventStream, seedProject } from '../fleet/testing/fleet-e2e';
import { RunsProjector } from '../history/runs-projector.service';
import { allowedLiveOrigin } from '../live/live-options';
import type { LiveE2eContext } from '../live/testing/live-e2e';
import { TestLiveSocket } from '../live/testing/live-e2e';
import { createUser, login, resetDatabase } from '../test/e2e-app';
import { ACTIVITY_OPTIONS, type ActivityOptions } from './activity-options';
import { ActivityProjector } from './activity-projector.service';
import { resetActivity, storeEvents } from './testing/activity-e2e';

/** The poll loop on, fast — the one suite that runs it as production does. */
const OPTIONS: ActivityOptions = {
  pollMs: 200,
  gapGraceMs: 0,
  retentionDays: 180,
  loop: true,
};

describe('activity live pushes (e2e)', () => {
  let ctx: LiveE2eContext;
  const sockets: TestLiveSocket[] = [];

  const open = async (email: string, role: 'admin' | 'viewer') => {
    await createUser(ctx.prisma, email, role);
    const session = await login(ctx, email);
    const socket = new TestLiveSocket(ctx.liveUrl, {
      token: session.token,
      origin: allowedLiveOrigin(),
    });
    sockets.push(socket);
    return socket.ready();
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ACTIVITY_OPTIONS)
      .useValue(OPTIONS)
      .compile();
    const app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    const origin = (await app.getUrl()).replace(/\/+$/, '');
    ctx = {
      app,
      prisma: app.get(PrismaService),
      http: () => request(app.getHttpServer()),
      liveUrl: `${origin.replace(/^http/, 'ws')}/live`,
    };
  });
  afterAll(async () => {
    // Let an in-flight tick finish, so it cannot race the next suite's reset.
    for (const loop of [
      ctx.app.get(ActivityProjector),
      ctx.app.get(RunsProjector),
    ]) {
      loop.onModuleDestroy();
      await loop.tick();
    }
    await ctx.app.close();
  });
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.socket.terminate();
  });

  /** Stops both poll loops around the TRUNCATEs, which would deadlock with them. */
  const reset = async () => {
    const loops = [ctx.app.get(ActivityProjector), ctx.app.get(RunsProjector)];
    for (const loop of loops) {
      loop.onModuleDestroy();
      await loop.tick();
    }
    await resetDatabase(ctx.prisma);
    await resetActivity(ctx.prisma);
    // A fresh projector starts at 0 and replays the whole source (spec 21 D2):
    // `audit_records` is append-only and keeps every earlier suite's records,
    // which would reach `admin` ahead of this test's own items. Start the
    // cursors at the current maximum so the test sees only what it creates.
    await ctx.prisma.$executeRaw`
      INSERT INTO activity_projector_state (id, "eventsCursor", "auditCursor", "updatedAt")
      VALUES (
        'activity',
        (SELECT COALESCE(MAX(id), 0) FROM events),
        (SELECT COALESCE(MAX(seq), 0) FROM audit_records),
        now()
      )`;
    for (const loop of loops) loop.onApplicationBootstrap();
  };

  it('pushes a new item to its project within 5 s, and project-less ones to admins only', async () => {
    await reset();
    const { runnerId, projectId } = await seedProject(ctx.prisma);
    const admin = await open('admin@example.com', 'admin');
    const member = await open('member@example.com', 'viewer');
    const memberId = (
      await ctx.prisma.user.findUniqueOrThrow({
        where: { email: 'member@example.com' },
      })
    ).id;
    await ctx.prisma.projectMember.create({
      data: { projectId, userId: memberId },
    });

    expect(await member.subscribe('admin')).toMatchObject({
      type: 'error',
      code: 'forbidden',
    });
    expect(await member.subscribe(`project:${projectId}`)).toMatchObject({
      type: 'subscribed',
    });
    expect(await admin.subscribe('admin')).toMatchObject({
      type: 'subscribed',
    });

    const stream = new EventStream();
    const truncated = stream.next('runner.spool_truncated', {
      fromSeq: 1,
      toSeq: 2,
      bytes: 1,
    });
    delete truncated.project;
    const started = Date.now();
    await storeEvents(ctx.prisma, runnerId, [
      stream.next('person.needed', { question: 'which base?' }),
      truncated,
    ]);

    const pushed = await member.next('event', 5_000);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(pushed).toMatchObject({
      topic: `project:${projectId}`,
      event: ACTIVITY_ITEM_LIVE_EVENT,
    });
    expect((pushed.data as ActivityItem).type).toBe('person.needed');

    const adminPush = await admin.next('event', 5_000);
    expect(adminPush.topic).toBe('admin');
    expect(adminPush.data as ActivityItem).toMatchObject({
      type: 'runner.spool_truncated',
      projectId: null,
    });

    // The member saw nothing else: no project-less item reached them.
    await expect(member.next('event', 500)).rejects.toThrow(/no event/);
  });

  it('pushes run.updated on the project when a slot gets its run', async () => {
    await reset();
    const { projectId } = await seedProject(ctx.prisma);
    const admin = await open('admin@example.com', 'admin');
    expect(await admin.subscribe(`project:${projectId}`)).toMatchObject({
      type: 'subscribed',
    });
    await ctx.prisma.slot.create({
      data: {
        projectId,
        name: 'i21',
        worktree: '/srv/dev/.wt-widget-i21',
        owns: [],
        never: [],
        status: 'running',
        lastSeq: 1n,
        startedAt: new Date('2026-10-08T10:00:00Z'),
        updatedAt: new Date('2026-10-08T10:00:00Z'),
      },
    });
    const pushed = await admin.next('event', 5_000);
    expect(pushed.event).toBe(RUN_UPDATED_LIVE_EVENT);
    expect((pushed.data as RunLiveChange).status).toBe('running');
  });
});
