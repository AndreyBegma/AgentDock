import {
  LIVE_SOCKET_PATH,
  type LiveServerMessage,
  MAX_LIVE_MESSAGE_BYTES,
} from '@agentdock/shared';
import {
  PANE_LIVE_EVENTS,
  PANE_MAX_VIEWERS_PER_SLOT,
  type PaneFrame,
  paneTopic,
  type ServerMessage,
} from '@agentdock/shared/protocol';
import { allowedLiveOrigin } from '../live/live-options';
import { TestLiveSocket } from '../live/testing/live-e2e';
import {
  adminSession,
  createRunnerE2eApp,
  eventually,
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
import { PaneRelay } from './pane-relay';

const ROOT_A = '/srv/dev/widget';
const ROOT_B = '/srv/dev/gadget';
/** Something the runner's redaction would mask; here it only marks pane text. */
const PANE_TEXT = 'counter 41 — pane-text-marker';

type Subscribe = Extract<ServerMessage, { type: 'subscribe' }>;
type Unsubscribe = Extract<ServerMessage, { type: 'unsubscribe' }>;
type PaneEvent = Extract<LiveServerMessage, { type: 'event' }>;

const full = (lines: string[]): PaneFrame => ({
  type: 'full',
  lines,
  cursor: { x: 0, y: lines.length },
});

describe('pane relay (e2e)', () => {
  let ctx: RunnerE2eContext;
  let relay: PaneRelay;
  let liveUrl: string;
  let admin: Session;
  let runnerToken: string;
  let projectA: string;
  let projectB: string;
  const runners: TestRunnerSocket[] = [];
  const browsers: TestLiveSocket[] = [];

  /** The audit chain is append-only: each test reads only what it added. */
  let auditFrom = 0n;

  const topicA = () => paneTopic(projectA, 'i42');

  const paneAudit = () =>
    ctx.prisma.auditRecord.findMany({
      where: { seq: { gt: auditFrom }, action: { startsWith: 'pane.' } },
      orderBy: { seq: 'asc' },
    });

  const seedProject = async (runnerId: string, root: string, slot: string) => {
    const project = await ctx.prisma.project.create({
      data: {
        runnerId,
        rootPath: root,
        repo: `acme/${root.slice(root.lastIndexOf('/') + 1)}`,
        displayName: root.slice(root.lastIndexOf('/') + 1),
        baseBranch: 'develop',
        baseSource: 'config',
        hasClaudeMd: true,
        hasAgentsMd: false,
        lastInspectedAt: new Date('2026-10-01T00:00:00Z'),
      },
    });
    const now = new Date();
    await ctx.prisma.slot.create({
      data: {
        projectId: project.id,
        name: slot,
        worktree: `${root.slice(0, root.lastIndexOf('/'))}/.wt-x-${slot}`,
        owns: [],
        never: [],
        status: 'running',
        lastSeq: 0n,
        startedAt: now,
        updatedAt: now,
      },
    });
    return project.id;
  };

  const signIn = async (email: string, role: 'operator' | 'viewer') => {
    const user = await createUser(ctx.prisma, email, role);
    return { id: user.id, session: await login(ctx, email) };
  };

  const member = async (email: string, projectId: string) => {
    const user = await signIn(email, 'viewer');
    await ctx.prisma.projectMember.create({
      data: { projectId, userId: user.id },
    });
    return user.session;
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

  /** Nothing of `type` arrives once the relay is idle. */
  const silent = async (
    socket: TestRunnerSocket | TestLiveSocket,
    type: 'subscribe' | 'unsubscribe' | 'event',
  ) => {
    await relay.settled();
    await expect(
      (socket.next as (t: string, ms: number) => Promise<unknown>).call(
        socket,
        type,
        300,
      ),
    ).rejects.toThrow(/no .* within/);
  };

  const frame = async (socket: TestLiveSocket): Promise<PaneEvent> => {
    const message = await socket.next('event');
    return message;
  };

  beforeAll(async () => {
    ctx = await createRunnerE2eApp();
    relay = ctx.app.get(PaneRelay);
    liveUrl = `${ctx.origin.replace(/^http/, 'ws')}${LIVE_SOCKET_PATH}`;
  });
  afterAll(() => ctx.app.close());
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    admin = await adminSession(ctx);
    const paired = await pairedRunner(ctx, admin);
    runnerToken = paired.token;
    projectA = await seedProject(paired.runnerId, ROOT_A, 'i42');
    const other = await pairedRunner(ctx, admin, 'other');
    projectB = await seedProject(other.runnerId, ROOT_B, 'b7');
    const last = await ctx.prisma.auditRecord.findFirst({
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    auditFrom = last?.seq ?? 0n;
  });
  afterEach(async () => {
    for (const socket of browsers.splice(0)) socket.socket.terminate();
    for (const socket of runners.splice(0)) socket.socket.terminate();
    await relay.settled();
  });

  describe('authorization', () => {
    it('lets a viewer-role member watch and streams frames to them', async () => {
      const desk = await runner();
      const viewer = await browser(await member('v@example.com', projectA));

      expect(await viewer.subscribe(topicA())).toEqual({
        type: 'subscribed',
        topic: topicA(),
      });
      const subscribe = await desk.next('subscribe');
      expect(subscribe).toEqual({
        type: 'subscribe',
        id: expect.stringMatching(/^pane_/),
        kind: 'pane',
        projectId: projectA,
        root: ROOT_A,
        slot: 'i42',
      });

      desk.send({ type: 'pane', id: subscribe.id, frame: full(['a', 'b']) });
      expect(await frame(viewer)).toMatchObject({
        topic: topicA(),
        event: PANE_LIVE_EVENTS.frame,
        data: full(['a', 'b']),
      });
      const patch: PaneFrame = { type: 'patch', from: 1, lines: ['\x1b[32mc'] };
      desk.send({ type: 'pane', id: subscribe.id, frame: patch });
      // ANSI escapes are relayed unchanged; the client decides how to render.
      expect((await frame(viewer)).data).toEqual(patch);
    });

    it('lets an admin watch any project', async () => {
      const desk = await runner();
      const socket = await browser(admin);
      expect((await socket.subscribe(topicA())).type).toBe('subscribed');
      await desk.next('subscribe');
    });

    it('refuses a non-member, without touching the runner', async () => {
      const desk = await runner();
      const outsider = await signIn('o@example.com', 'operator');
      const socket = await browser(outsider.session);
      expect(await socket.subscribe(topicA())).toEqual({
        type: 'error',
        topic: topicA(),
        code: 'forbidden',
      });
      await silent(desk, 'subscribe');
    });

    it('refuses a slot of another project named under a project the member sees', async () => {
      const desk = await runner();
      const socket = await browser(await member('v@example.com', projectA));
      const crossed = paneTopic(projectA, 'b7');
      expect(await socket.subscribe(crossed)).toEqual({
        type: 'error',
        topic: crossed,
        code: 'not_found',
      });
      // And B's own topic is not theirs at all.
      expect(await socket.subscribe(paneTopic(projectB, 'b7'))).toMatchObject({
        code: 'forbidden',
      });
      await silent(desk, 'subscribe');
    });

    it('accepts no input on a pane topic: the only client messages are subscribe, unsubscribe and ping', async () => {
      const socket = await browser(await member('v@example.com', projectA));
      socket.send({ type: 'input', topic: topicA(), data: 'rm -rf /\n' });
      expect(await socket.next('error')).toEqual({
        type: 'error',
        code: 'invalid_message',
      });
    });
  });

  describe('fan-out', () => {
    it('keeps one runner subscription for two browsers and resubscribes for the late joiner', async () => {
      const desk = await runner();
      const session = await member('v@example.com', projectA);
      const first = await browser(session);
      const second = await browser(admin);

      await first.subscribe(topicA());
      const one = await desk.next('subscribe');
      await second.subscribe(topicA());
      // The late joiner needs a `full`: the old stream is dropped, a new one opened.
      expect(await desk.next('unsubscribe')).toEqual({
        type: 'unsubscribe',
        id: one.id,
      });
      const two = await desk.next('subscribe');
      expect(two.id).not.toBe(one.id);
      await silent(desk, 'subscribe');

      // A frame still in flight on the old id is dropped.
      desk.send({ type: 'pane', id: one.id, frame: full(['stale']) });
      desk.send({ type: 'pane', id: two.id, frame: full(['fresh']) });
      expect((await frame(first)).data).toEqual(full(['fresh']));
      expect((await frame(second)).data).toEqual(full(['fresh']));

      first.send({ type: 'unsubscribe', topic: topicA() });
      await silent(desk, 'unsubscribe');
      // The last one leaving — here by closing the tab — stops the stream.
      second.socket.close();
      expect(await desk.next('unsubscribe')).toEqual({
        type: 'unsubscribe',
        id: two.id,
      });
    });

    it('refuses the viewer past the per-slot cap', async () => {
      await runner();
      const sockets: TestLiveSocket[] = [];
      // Five sockets per login session, so a few sessions of one member.
      await member('v@example.com', projectA);
      while (sockets.length < PANE_MAX_VIEWERS_PER_SLOT + 1) {
        const session = await login(ctx, 'v@example.com');
        for (let i = 0; i < 5; i++) sockets.push(await browser(session));
      }
      for (const socket of sockets.slice(0, PANE_MAX_VIEWERS_PER_SLOT)) {
        expect((await socket.subscribe(topicA())).type).toBe('subscribed');
      }
      expect(
        await sockets[PANE_MAX_VIEWERS_PER_SLOT].subscribe(topicA()),
      ).toEqual({ type: 'error', topic: topicA(), code: 'too_many_viewers' });
    });

    it('splits a frame larger than a /live message into a full and patches', async () => {
      const desk = await runner();
      const viewer = await browser(admin);
      await viewer.subscribe(topicA());
      const { id } = await desk.next('subscribe');

      const lines = Array.from(
        { length: 2000 },
        (_, i) =>
          `\x1b[1m${String(i).padStart(4, '0')}\x1b[0m ${'x'.repeat(100)}`,
      );
      desk.send({ type: 'pane', id, frame: full(lines) });

      const pieces: PaneFrame[] = [];
      let rebuilt: string[] = [];
      while (rebuilt.length < lines.length) {
        const piece = (await frame(viewer)).data as PaneFrame;
        pieces.push(piece);
        if (piece.type === 'full') rebuilt = [...piece.lines];
        if (piece.type === 'patch') {
          rebuilt = [...rebuilt.slice(0, piece.from), ...piece.lines];
        }
      }
      expect(pieces[0].type).toBe('full');
      expect(pieces.length).toBeGreaterThan(1);
      expect(rebuilt).toEqual(lines);
      expect(MAX_LIVE_MESSAGE_BYTES).toBeLessThan(
        Buffer.byteLength(JSON.stringify(full(lines))),
      );
    });
  });

  describe('lifecycle', () => {
    it('delivers ended and keeps the viewer on the topic', async () => {
      const desk = await runner();
      const viewer = await browser(admin);
      await viewer.subscribe(topicA());
      const { id } = await desk.next('subscribe');

      desk.send({ type: 'pane', id, frame: { type: 'ended' } });
      expect(await frame(viewer)).toMatchObject({
        topic: topicA(),
        event: PANE_LIVE_EVENTS.ended,
        data: null,
      });
      // The runner already dropped it; nothing more on that id is relayed.
      desk.send({ type: 'pane', id, frame: full(['after']) });
      await silent(viewer, 'event');
      viewer.send({ type: 'unsubscribe', topic: topicA() });
      await silent(desk, 'unsubscribe');
    });

    it("passes the runner's refusal to every viewer and unsubscribes them", async () => {
      const desk = await runner();
      const viewer = await browser(admin);
      await viewer.subscribe(topicA());
      const { id } = await desk.next('subscribe');

      desk.send({ type: 'subscribe.error', id, code: 'too_many_viewers' });
      expect(await viewer.next('error')).toEqual({
        type: 'error',
        topic: topicA(),
        code: 'too_many_viewers',
      });
      await relay.settled();
      // Unsubscribed: no `unsubscribe` goes back for a stream the runner refused.
      await silent(desk, 'unsubscribe');
      expect((await viewer.subscribe(topicA())).type).toBe('subscribed');
      await desk.next('subscribe');
    });

    it('subscribes when the runner comes online, and again after it reconnects', async () => {
      const viewer = await browser(admin);
      await viewer.subscribe(topicA());

      const first = await runner();
      const one = await first.next('subscribe');
      first.socket.terminate();
      await eventually('runner offline', async () => {
        await relay.settled();
        return first.socket.readyState === first.socket.CLOSED
          ? true
          : undefined;
      });

      const second = await runner();
      const two = await second.next('subscribe');
      expect(two).toMatchObject<Partial<Subscribe>>({
        projectId: projectA,
        slot: 'i42',
      });
      expect(two.id).not.toBe(one.id);
      second.send({ type: 'pane', id: two.id, frame: full(['back']) });
      expect((await frame(viewer)).data).toEqual(full(['back']));
    });

    it("ignores another runner's frames for a stream it does not own", async () => {
      const desk = await runner();
      const viewer = await browser(admin);
      await viewer.subscribe(topicA());
      const { id } = await desk.next('subscribe');

      const intruder = await pairedRunner(ctx, admin, 'intruder');
      const socket = new TestRunnerSocket(ctx.origin, intruder.token);
      runners.push(socket);
      await socket.connect();
      socket.send({ type: 'pane', id, frame: full(['spoofed']) });
      await silent(viewer, 'event');
    });
  });

  describe('persistence', () => {
    it('stores no pane text, only who watched', async () => {
      const desk = await runner();
      const eventsBefore = await ctx.prisma.event.count();
      const viewer = await browser(admin);
      await viewer.subscribe(topicA());
      const { id } = await desk.next('subscribe');
      desk.send({ type: 'pane', id, frame: full([PANE_TEXT]) });
      await frame(viewer);
      viewer.send({ type: 'unsubscribe', topic: topicA() });
      const unsubscribe: Unsubscribe = await desk.next('unsubscribe');
      expect(unsubscribe.id).toBe(id);

      expect(await ctx.prisma.event.count()).toBe(eventsBefore);
      const audit = await eventually('watch audited', async () => {
        const rows = await paneAudit();
        return rows.length === 2 ? rows : undefined;
      });
      expect(audit.map((r) => [r.action, r.targetType, r.targetId])).toEqual([
        ['pane.watch_started', 'slot', 'i42'],
        ['pane.watch_stopped', 'slot', 'i42'],
      ]);
      expect(audit.every((r) => r.projectId === projectA)).toBe(true);
      const everything = JSON.stringify(
        await ctx.prisma.auditRecord.findMany(),
        (_, value) => (typeof value === 'bigint' ? String(value) : value),
      );
      expect(everything).not.toContain('pane-text-marker');
    });

    it('audits a user once however many tabs they watch from', async () => {
      const desk = await runner();
      const tabs = [await browser(admin), await browser(admin)];
      for (const tab of tabs) await tab.subscribe(topicA());
      await desk.next('subscribe');
      for (const tab of tabs) tab.socket.close();
      await desk.next('unsubscribe');
      await relay.settled();
      const actions = await eventually('watch audited', async () => {
        const rows = await paneAudit();
        return rows.length >= 2 ? rows.map((r) => r.action) : undefined;
      });
      expect(actions).toEqual(['pane.watch_started', 'pane.watch_stopped']);
    });
  });
});
