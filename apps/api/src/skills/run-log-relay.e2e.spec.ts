import {
  LIVE_SOCKET_PATH,
  type LiveServerMessage,
  runTopic,
} from '@nautelle/shared';
import {
  RUN_LOG_LIVE_EVENTS,
  type RunLogFrame,
} from '@nautelle/shared/protocol';
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

  it('relays a running UI profile build to any member of the project (spec 223 D17)', async () => {
    const desk = await runner();
    const now = new Date();
    const { id: runId } = await ctx.prisma.run.create({
      data: {
        kind: 'ui_profile',
        projectId,
        status: 'running',
        triggeredByType: 'user',
        startedAt: now,
        updatedAt: now,
        args: { projectId, reason: 'first', obligations: null, waiting: [] },
      },
    });
    const topic = runTopic(projectId, runId);
    const page = await browser(viewer);

    expect(await page.subscribe(topic)).toEqual({ type: 'subscribed', topic });
    const subscribe = await desk.next('subscribe');
    expect(subscribe).toMatchObject({ kind: 'run_log', projectId, runId });
    desk.send({ type: 'run_log', id: subscribe.id, frame: lines(MARKER) });
    expect(await page.next('event')).toMatchObject({
      topic,
      event: RUN_LOG_LIVE_EVENTS.lines,
      data: lines(MARKER),
    });
  });

  describe('a plan turn (#183)', () => {
    let author: Session;
    let other: Session;

    const member = async (email: string) => {
      const user = await createUser(ctx.prisma, email, 'operator');
      await ctx.prisma.projectMember.create({
        data: { projectId, userId: user.id },
      });
      return user;
    };

    /** A running turn of a private plan by `author@example.com`. */
    const seedTurn = async (phase: 'running' | 'succeeded' = 'running') => {
      const authorId = (
        await ctx.prisma.user.findUniqueOrThrow({
          where: { email: 'author@example.com' },
        })
      ).id;
      const instructions = await ctx.prisma.plannerInstructions.create({
        data: { projectId: null, version: 1, body: 'INSTRUCTIONS' },
      });
      const plan = await ctx.prisma.plan.create({
        data: {
          projectId,
          authorId,
          title: 'Exporter',
          brief: 'Build an exporter',
          mode: 'batch',
          status: 'drafting',
          sessionId: '11111111-1111-4111-8111-111111111111',
          instructionsId: instructions.id,
          contractVersion: 1,
          profileKey: 'claude-main',
          model: 'opus',
        },
      });
      const now = new Date();
      const run = await ctx.prisma.run.create({
        data: {
          kind: 'plan',
          projectId,
          status: phase,
          triggeredByType: 'user',
          triggeredById: authorId,
          startedAt: now,
          updatedAt: now,
          planTurn: {
            create: {
              planId: plan.id,
              action: 'decompose',
              authorId,
              input: {},
              phase,
            },
          },
        },
      });
      return { planId: plan.id, runId: run.id };
    };

    beforeEach(async () => {
      await member('author@example.com');
      await member('other@example.com');
      author = await login(ctx, 'author@example.com');
      other = await login(ctx, 'other@example.com');
    });

    it('relays the live line to a reader of the plan', async () => {
      const desk = await runner();
      const { runId } = await seedTurn();
      const topic = runTopic(projectId, runId);
      const page = await browser(author);

      expect(await page.subscribe(topic)).toEqual({
        type: 'subscribed',
        topic,
      });
      const subscribe = await desk.next('subscribe');
      expect(subscribe).toMatchObject({ kind: 'run_log', projectId, runId });
      desk.send({ type: 'run_log', id: subscribe.id, frame: lines(MARKER) });
      expect(await page.next('event')).toMatchObject({
        topic,
        event: RUN_LOG_LIVE_EVENTS.lines,
        data: lines(MARKER),
      });
    });

    it('gives another operator nothing on a private plan’s topic, and opens it once shared', async () => {
      const desk = await runner();
      const { planId, runId } = await seedTurn();
      const topic = runTopic(projectId, runId);
      const page = await browser(other);

      expect(await page.subscribe(topic)).toMatchObject({
        type: 'error',
        topic,
        code: 'not_found',
      });
      await relay.settled();
      await expect(desk.next('subscribe', 300)).rejects.toThrow(/no .* within/);

      // A reader's line on the same run never reaches them.
      const reader = await browser(author);
      await reader.subscribe(topic);
      const subscribe = await desk.next('subscribe');
      desk.send({ type: 'run_log', id: subscribe.id, frame: lines(MARKER) });
      await reader.next('event');
      await expect(page.next('event', 300)).rejects.toThrow(/no .* within/);

      await ctx.prisma.plan.update({
        where: { id: planId },
        data: { visibility: 'project' },
      });
      expect(await page.subscribe(topic)).toEqual({
        type: 'subscribed',
        topic,
      });
    });

    it('does not subscribe for a turn that already ended', async () => {
      const desk = await runner();
      const { runId } = await seedTurn('succeeded');
      const page = await browser(author);
      expect(await page.subscribe(runTopic(projectId, runId))).toMatchObject({
        type: 'subscribed',
      });
      await relay.settled();
      await expect(desk.next('subscribe', 300)).rejects.toThrow(/no .* within/);
    });
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
