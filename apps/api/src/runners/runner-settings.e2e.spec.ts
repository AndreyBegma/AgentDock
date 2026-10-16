import { seedProject } from '../fleet/testing/fleet-e2e';
import {
  createUser,
  login,
  resetDatabase,
  type Session,
} from '../test/e2e-app';
import {
  adminSession,
  createRunnerE2eApp,
  pairedRunner,
  type RunnerE2eContext,
  TestRunnerSocket,
} from './testing/runner-e2e';

/**
 * Spec 201 "API": `PATCH runners/:id` — the local user (admin only) and away
 * mode (admin or the runner's local user), audited as `runner.update`; a
 * change of away mode is pushed in `config`. The config also carries each
 * project's `shipContent`.
 */
describe('runner settings (e2e)', () => {
  let ctx: RunnerE2eContext;
  let admin: Session;
  let runnerId: string;
  let token: string;
  let me: Session;
  let meId: string;
  let other: Session;
  const sockets: TestRunnerSocket[] = [];

  beforeAll(async () => {
    ctx = await createRunnerE2eApp();
  });
  afterAll(async () => {
    for (const s of sockets) s.socket.close();
    await ctx.app.close();
  });
  beforeEach(async () => {
    for (const s of sockets.splice(0)) s.socket.close();
    await resetDatabase(ctx.prisma);
    admin = await adminSession(ctx);
    ({ runnerId, token } = await pairedRunner(ctx, admin));
    meId = (await createUser(ctx.prisma, 'me@example.com', 'operator')).id;
    me = await login(ctx, 'me@example.com');
    await createUser(ctx.prisma, 'other@example.com', 'operator');
    other = await login(ctx, 'other@example.com');
  });

  const connect = async () => {
    const socket = new TestRunnerSocket(ctx.origin, token);
    sockets.push(socket);
    return { socket, welcome: await socket.connect() };
  };

  it('defaults the local user to the creating admin', async () => {
    const runner = await ctx.prisma.runner.findUniqueOrThrow({
      where: { id: runnerId },
    });
    expect(runner.localUserId).toBe(runner.createdById);
    const listed = await admin.get('/admin/runners');
    expect(listed.body[0]).toMatchObject({
      localUserId: runner.createdById,
      awayMode: false,
    });
  });

  it('lets an admin set the local user, and refuses anyone else', async () => {
    expect(
      (await me.send('patch', `/runners/${runnerId}`, { localUserId: meId }))
        .status,
    ).toBe(403);
    const response = await admin.send('patch', `/runners/${runnerId}`, {
      localUserId: meId,
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ localUserId: meId, awayMode: false });
    expect(
      (
        await admin.send('patch', `/admin/runners/${runnerId}`, {
          localUserId: 'no-such-user',
        })
      ).status,
    ).toBe(422);
    const [update] = await ctx.prisma.auditRecord.findMany({
      where: { action: 'runner.update', targetId: runnerId },
    });
    expect(update).toMatchObject({
      actorType: 'user',
      after: { localUserId: meId },
      result: 'ok',
    });
  });

  it('lets the local user switch away mode, pushes it, and hides the runner from others', async () => {
    await admin.send('patch', `/admin/runners/${runnerId}`, {
      localUserId: meId,
    });
    const { projectId } = await seedProject(
      ctx.prisma,
      '/srv/dev/widget',
      runnerId,
    );
    await ctx.prisma.project.update({
      where: { id: projectId },
      data: { shipSessionContent: true },
    });
    const { socket, welcome } = await connect();
    expect(welcome.config).toEqual({
      projects: [
        {
          id: projectId,
          root: '/srv/dev/widget',
          shipContent: true,
          steward: { enabled: true, silenceMinutes: 10, trailerGuard: true },
        },
      ],
      pollIntervalsMs: {},
    });

    expect(
      (await other.send('patch', `/runners/${runnerId}`, { awayMode: true }))
        .status,
    ).toBe(404);
    expect((await other.get('/runners/local')).body).toEqual([]);

    const on = await me.send('patch', `/runners/${runnerId}`, {
      awayMode: true,
    });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ id: runnerId, awayMode: true });
    expect((await socket.next('config')).config.awayMode).toBe(true);
    expect((await me.get('/runners/local')).body).toEqual([
      { id: runnerId, name: 'desk', localUserId: meId, awayMode: true },
    ]);

    expect(
      (await me.send('patch', `/runners/${runnerId}`, { awayMode: 'yes' }))
        .status,
    ).toBe(400);
    expect(
      (
        await admin.send('patch', `/admin/runners/${runnerId}`, {
          awayMode: false,
        })
      ).body,
    ).toMatchObject({ awayMode: false });
    expect((await socket.next('config')).config.awayMode).toBeUndefined();
  });
});
