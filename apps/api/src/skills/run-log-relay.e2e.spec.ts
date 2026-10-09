import {
  LIVE_SOCKET_PATH,
  type LiveServerMessage,
  runTopic,
} from '@agentdock/shared';
import {
  RUN_LOG_LIVE_EVENTS,
  type RunLogFrame,
} from '@agentdock/shared/protocol';
import { allowedLiveOrigin } from '../live/live-options';
import { TestLiveSocket } from '../live/testing/live-e2e';
import { PaneRelay } from '../pane/pane-relay';
import {
  adminSession,
  createRunnerE2eApp,
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
import { RunLogRelay } from './run-log-relay';

const ROOT = '/srv/dev/widget';
const MARKER = 'stream-text-marker';

type LiveEvent = Extract<LiveServerMessage, { type: 'event' }>;

const lines = (text: string, backlog = false): RunLogFrame => ({
  type: 'lines',
  backlog,
  lines: [{ kind: 'assistant', text }],
});

describe('skill run live log (e2e)', () => {
  let ctx: RunnerE2eContext;
  let relay: RunLogRelay;
  let panes: PaneRelay;
  let liveUrl: string;
  let runnerToken: string;
  let projectId: string;
  let viewer: Session;
  const runners: TestRunnerSocket[] = [];
  const browsers: TestLiveSocket[] = [];

  const seedRun = async (phase: 'running' | 'succeeded' = 'running') => {
    const now = new Date();
    const run = await ctx.prisma.run.create({
      data: {
        kind: 'skill',
        projectId,
        status: phase,
        triggeredByType: 'user',
        startedAt: now,
        updatedAt: now,
        skillRun: {
          create: {
            skill: 'estimate',
            args: '',
            profileKey: 'claude-main',
            model: 'opus',
            permissionMode: 'auto',
            output: 'report',
            phase,
            timeoutSec: 3600,
          },
        },
      },
    });
    return run.id;
  };

  const browser = async (session: Session) => {
    const socket = new TestLiveSocket(liveUrl, {
      token: session.token,
      origin: allowedLiveOrigin(),
    });
    browsers.push(socket);
    return socket.ready();
  };

  const runner = async () => {
    const socket = new TestRunnerSocket(ctx.origin, runnerToken);
    runners.push(socket);
    await socket.connect();
    return socket;
  };

  beforeAll(async () => {
    ctx = await createRunnerE2eApp();
    relay = ctx.app.get(RunLogRelay);
    panes = ctx.app.get(PaneRelay);
    liveUrl = `${ctx.origin.replace(/^http/, 'ws')}${LIVE_SOCKET_PATH}`;
  });
  afterAll(() => ctx.app.close());
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    const admin = await adminSession(ctx);
    const paired = await pairedRunner(ctx, admin);
    runnerToken = paired.token;
    const project = await ctx.prisma.project.create({
      data: {
        runnerId: paired.runnerId,
        rootPath: ROOT,
        repo: 'acme/widget',
        displayName: 'widget',
        baseBranch: 'develop',
        baseSource: 'config',
        hasClaudeMd: true,
        hasAgentsMd: false,
        lastInspectedAt: new Date('2026-10-01T00:00:00Z'),
      },
    });
    projectId = project.id;
    const user = await createUser(ctx.prisma, 'v@example.com', 'viewer');
    await ctx.prisma.projectMember.create({
      data: { projectId, userId: user.id },
    });
    viewer = await login(ctx, 'v@example.com');
  });
  afterEach(async () => {
    for (const socket of browsers.splice(0)) socket.socket.terminate();
    for (const socket of runners.splice(0)) socket.socket.terminate();
    await relay.settled();
    await panes.settled();
  });

  it('subscribes the runner on the first viewer, relays rendered lines, and stores none of them', async () => {
    const desk = await runner();
    const runId = await seedRun();
    const topic = runTopic(projectId, runId);
    const page = await browser(viewer);

    expect(await page.subscribe(topic)).toEqual({ type: 'subscribed', topic });
    const subscribe = await desk.next('subscribe');
    expect(subscribe).toEqual({
      type: 'subscribe',
      id: expect.stringMatching(/^runlog_/),
      kind: 'run_log',
      projectId,
      runId,
    });

    desk.send({ type: 'run_log', id: subscribe.id, frame: lines(MARKER) });
    const event = (await page.next('event')) as LiveEvent;
    expect(event).toMatchObject({
      topic,
      event: RUN_LOG_LIVE_EVENTS.lines,
      data: lines(MARKER),
    });

    desk.send({
      type: 'run_log',
      id: subscribe.id,
      frame: { type: 'ended', phase: 'succeeded' },
    });
    expect(await page.next('event')).toMatchObject({
      topic,
      event: RUN_LOG_LIVE_EVENTS.ended,
      data: { type: 'ended', phase: 'succeeded' },
    });

    const row = await ctx.prisma.skillRun.findUniqueOrThrow({
      where: { runId },
    });
    expect(JSON.stringify(row)).not.toContain(MARKER);
    const stored = await ctx.prisma.event.findMany();
    expect(JSON.stringify(stored)).not.toContain(MARKER);
  });

  it('unsubscribes the runner when the last viewer leaves', async () => {
    const desk = await runner();
    const runId = await seedRun();
    const page = await browser(viewer);
    await page.subscribe(runTopic(projectId, runId));
    const subscribe = await desk.next('subscribe');

    page.socket.terminate();
    expect(await desk.next('unsubscribe')).toEqual({
      type: 'unsubscribe',
      id: subscribe.id,
    });
  });

  it('does not subscribe for a run that already ended', async () => {
    const desk = await runner();
    const runId = await seedRun('succeeded');
    const page = await browser(viewer);
    expect(await page.subscribe(runTopic(projectId, runId))).toMatchObject({
      type: 'subscribed',
    });
    await relay.settled();
    await expect(desk.next('subscribe', 300)).rejects.toThrow(/no .* within/);
  });

  it('drops a run_log frame for a subscription it did not open', async () => {
    const desk = await runner();
    const runId = await seedRun();
    const page = await browser(viewer);
    await page.subscribe(runTopic(projectId, runId));
    await desk.next('subscribe');

    desk.send({ type: 'run_log', id: 'runlog_forged', frame: lines('x') });
    await relay.settled();
    await expect(page.next('event', 300)).rejects.toThrow(/no .* within/);
  });
});
