import { FLEET_LIVE_EVENT, type FleetView } from '@agentdock/shared';
import type { RunnerEvent } from '@agentdock/shared/protocol';
import { Logger } from '@nestjs/common';
import { allowedLiveOrigin } from '../live/live-options';
import { TestLiveSocket } from '../live/testing/live-e2e';
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
import { EventStream, ROOT, seedProject } from './testing/fleet-e2e';

/** Fleet events through a real runner socket: the sink, the ack, the push. */
describe('fleet ingest (e2e)', () => {
  let ctx: RunnerE2eContext;
  let runnerId: string;
  let token: string;
  let projectId: string;
  let member: Session;
  let stream: EventStream;
  const closers: (() => void)[] = [];

  const runnerSocket = async (lastAckedSeq = 0) => {
    const socket = new TestRunnerSocket(ctx.origin, token);
    closers.push(() => socket.socket.terminate());
    await socket.connect(hello({ lastAckedSeq }));
    return socket;
  };

  const send = async (socket: TestRunnerSocket, events: RunnerEvent[]) => {
    socket.send({ type: 'events', events });
    const ack = await socket.next('ack');
    expect(ack.seq).toBe(events.at(-1)?.seq);
  };

  const fleet = async () =>
    (await member.get(`/projects/${projectId}/fleet`)).body as FleetView;

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
    member = await login(ctx, 'member@example.com');
    stream = new EventStream();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const close of closers.splice(0)) close();
  });

  it('projects a batch from the runner and pushes the change within 5 s', async () => {
    const live = new TestLiveSocket(
      `${ctx.origin.replace(/^http/, 'ws')}/live`,
      { token: member.token, origin: allowedLiveOrigin() },
    );
    closers.push(() => live.socket.close());
    await live.ready();
    expect((await live.subscribe(`project:${projectId}`)).type).toBe(
      'subscribed',
    );

    const socket = await runnerSocket();
    const started = Date.now();
    await send(socket, [
      stream.next('session.appeared', { name: 'cs-i42' }, { slot: 'i42' }),
      stream.next(
        'slot.checkpoint',
        { checkpoint: 'plan_ready', heading: 'plan ready', position: 0 },
        { slot: 'i42', source: 'scraped' },
      ),
    ]);
    const frame = await live.next('event', 5_000);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(frame).toMatchObject({
      topic: `project:${projectId}`,
      event: FLEET_LIVE_EVENT,
      data: { kind: 'slot' },
    });

    expect((await fleet()).slots).toMatchObject([
      { name: 'i42', status: 'running', lastCheckpoint: 'plan_ready' },
    ]);
    expect(await ctx.prisma.event.count({ where: { runnerId } })).toBe(2);
  });

  it('fails the batch on a database failure: 1011, nothing stored, the resend projects', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const socket = await runnerSocket();
    await send(socket, [
      stream.next('session.appeared', { name: 'cs-i41' }, { slot: 'i41' }),
    ]);

    const failing = [
      stream.next('session.appeared', { name: 'cs-i42' }, { slot: 'i42' }),
    ];
    jest
      .spyOn(ctx.prisma, '$transaction')
      .mockRejectedValueOnce(new Error('database down'));
    socket.send({ type: 'events', events: failing });
    expect((await socket.closed).code).toBe(1011);
    expect(await ctx.prisma.event.count({ where: { runnerId } })).toBe(1);
    expect(
      (await ctx.prisma.runner.findUniqueOrThrow({ where: { id: runnerId } }))
        .ackedSeq,
    ).toBe(1n);
    expect((await fleet()).slots.map((s) => s.name)).toEqual(['i41']);

    const again = await runnerSocket(1);
    await send(again, failing);
    expect(await ctx.prisma.event.count({ where: { runnerId } })).toBe(2);
    expect((await fleet()).slots.map((s) => s.name).sort()).toEqual([
      'i41',
      'i42',
    ]);
  });
});
