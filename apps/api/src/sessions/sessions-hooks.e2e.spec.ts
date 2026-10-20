import type { SessionContentPage, SessionSummary } from '@nautelle/shared';
import type { RunnerEvent } from '@nautelle/shared/protocol';
import { Logger } from '@nestjs/common';
import {
  adminSession,
  CapturingLogger,
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
import { SessionContentService } from './session-content.service';

const T0 = Date.parse('2026-10-14T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const text = (value: string) => ({ text: value, truncated: false });
const tokens = (input: number, output: number) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  reasoning: 0,
});

describe('manual sessions: hook ingest (e2e)', () => {
  let ctx: RunnerE2eContext;
  let admin: Session;
  let seq = 0;
  const sockets: TestRunnerSocket[] = [];

  const hook = (
    type: string,
    sessionId: string,
    data: unknown,
    s: number,
    extra: Partial<RunnerEvent> = {},
  ): RunnerEvent => {
    seq += 1;
    return {
      v: 1,
      seq,
      ts: at(s),
      type,
      source: 'hook',
      session: { runtime: 'claude', id: sessionId },
      data,
      ...extra,
    } as RunnerEvent;
  };

  const transcript = (
    type: string,
    sessionId: string,
    data: unknown,
    s: number,
    source: 'transcript' | 'otel' = 'transcript',
  ): RunnerEvent => {
    seq += 1;
    return {
      v: 1,
      seq,
      ts: at(s),
      type,
      source,
      session: { runtime: 'claude', id: sessionId },
      data,
    } as RunnerEvent;
  };

  const project = (runnerId: string, name: string, ship = false) =>
    ctx.prisma.project.create({
      data: {
        runnerId,
        rootPath: `/srv/dev/${name}`,
        repo: `acme/${name}`,
        displayName: name,
        baseBranch: 'develop',
        baseSource: 'config',
        hasClaudeMd: true,
        hasAgentsMd: false,
        lastInspectedAt: new Date(),
        shipSessionContent: ship,
      },
    });

  const runner = async () => {
    const { runnerId, token } = await pairedRunner(ctx, admin);
    const socket = new TestRunnerSocket(ctx.origin, token);
    sockets.push(socket);
    await socket.connect();
    const send = async (events: RunnerEvent[]) => {
      socket.send({ type: 'events', events });
      const ack = await socket.next('ack');
      expect(ack.seq).toBe(events.at(-1)?.seq);
    };
    return { runnerId, socket, send };
  };

  const projectEnvelope = (name: string) => ({
    project: { repo: `acme/${name}`, root: `/srv/dev/${name}` },
  });

  const userOn = async (
    projectId: string,
    email: string,
    role?: 'operator',
  ) => {
    const user = await createUser(ctx.prisma, email, role ?? 'viewer');
    await ctx.prisma.projectMember.create({
      data: { projectId, userId: user.id },
    });
    return { user, session: await login(ctx, email) };
  };

  const sessionRow = (externalId: string) =>
    ctx.prisma.agentSession.findFirstOrThrow({ where: { externalId } });

  beforeAll(async () => {
    ctx = await createRunnerE2eApp({}, new CapturingLogger());
  });
  afterAll(() => ctx.app.close());
  beforeEach(async () => {
    seq = 0;
    await resetDatabase(ctx.prisma);
    admin = await adminSession(ctx);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const socket of sockets.splice(0)) socket.socket.terminate();
  });

  describe('origin, issue, owner and live state (criterion 3)', () => {
    it('follows a manual session from start to end', async () => {
      const r = await runner();
      const p = await project(r.runnerId, 'widget');
      const owner = await createUser(ctx.prisma, 'owner@example.com', 'viewer');
      await ctx.prisma.runner.update({
        where: { id: r.runnerId },
        data: { localUserId: owner.id },
      });
      const env = projectEnvelope('widget');

      await r.send([
        hook(
          'hook.session_started',
          'm1',
          {
            source: 'startup',
            cwd: '/srv/dev/widget',
            gitBranch: 'feat/184-x',
            permissionMode: 'default',
            tmuxSession: 'nautelle-manual-0123abcd',
          },
          0,
          env,
        ),
      ]);
      let row = await sessionRow('m1');
      expect(row).toMatchObject({
        origin: 'manual',
        issue: 184,
        ownerId: owner.id,
        liveState: 'idle',
        parsed: false,
        projectId: p.id,
        tmuxSession: 'nautelle-manual-0123abcd',
        cwd: '/srv/dev/widget',
        endedAt: null,
      });

      await r.send([hook('hook.prompt_submitted', 'm1', { chars: 3 }, 1, env)]);
      expect((await sessionRow('m1')).liveState).toBe('working');
      await r.send([
        hook('hook.permission_requested', 'm1', { toolName: 'Bash' }, 2, env),
      ]);
      expect((await sessionRow('m1')).liveState).toBe('waiting');
      await r.send([hook('hook.stopped', 'm1', {}, 3, env)]);
      expect((await sessionRow('m1')).liveState).toBe('idle');
      await r.send([
        hook('hook.session_ended', 'm1', { reason: 'other' }, 4, env),
      ]);
      row = await sessionRow('m1');
      expect(row.liveState).toBe('ended');
      expect(row.endedAt?.toISOString()).toBe(at(4));

      // The summary carries the new fields.
      const response = await admin.get(`/sessions?projectId=${p.id}`);
      expect(response.status).toBe(200);
      const [summary] = response.body.items as SessionSummary[];
      expect(summary).toMatchObject({
        origin: 'manual',
        issue: 184,
        ownerId: owner.id,
        liveState: 'ended',
        hasContent: false,
      });
    });

    it('lets the transcript fill the session without clobbering hook fields', async () => {
      const r = await runner();
      const p = await project(r.runnerId, 'widget');
      await r.send([
        hook(
          'hook.session_started',
          'm1',
          {
            source: 'startup',
            cwd: '/srv/dev/widget',
            gitBranch: 'fix/9-y',
            permissionMode: 'default',
          },
          0,
          projectEnvelope('widget'),
        ),
        transcript(
          'session.observed',
          'm1',
          {
            cwd: '/srv/dev/widget',
            startedAt: at(0),
            parsed: true,
            projectId: p.id,
            title: 'Fix it',
          },
          1,
        ),
      ]);
      expect(await sessionRow('m1')).toMatchObject({
        origin: 'manual',
        issue: 9,
        liveState: 'idle',
        parsed: true,
        title: 'Fix it',
      });
    });

    it('keeps a slot session a worker when it fires hooks, and takes the slot issue', async () => {
      const r = await runner();
      const p = await project(r.runnerId, 'widget');
      await ctx.prisma.slot.create({
        data: {
          projectId: p.id,
          name: 'i42',
          issue: 42,
          worktree: '/srv/dev/.wt-widget-i42',
          owns: [],
          never: [],
          status: 'running',
          lastSeq: 0n,
          startedAt: new Date(T0),
          updatedAt: new Date(T0),
        },
      });
      await r.send([
        hook(
          'hook.session_started',
          'w1',
          {
            source: 'startup',
            cwd: '/srv/dev/.wt-widget-i42',
            gitBranch: 'feat/7-z',
            permissionMode: 'default',
          },
          0,
          projectEnvelope('widget'),
        ),
        transcript(
          'session.observed',
          'w1',
          {
            cwd: '/srv/dev/.wt-widget-i42',
            startedAt: at(0),
            parsed: true,
            projectId: p.id,
            slot: 'i42',
          },
          1,
        ),
        hook('hook.stopped', 'w1', {}, 2),
      ]);
      expect(await sessionRow('w1')).toMatchObject({
        origin: 'worker',
        issue: 42,
        slotName: 'i42',
      });
    });
  });

  describe('content (ADR-0021)', () => {
    const promptAndTool = (env: object) => [
      hook(
        'hook.session_started',
        'm1',
        {
          source: 'startup',
          cwd: '/srv/dev/widget',
          permissionMode: 'default',
        },
        0,
        env,
      ),
      hook(
        'hook.prompt_submitted',
        'm1',
        { chars: 9, content: text('my prompt') },
        1,
        env,
      ),
      hook(
        'hook.tool_finished',
        'm1',
        {
          toolUseId: 'tu_1',
          toolName: 'Bash',
          ok: true,
          input: text('ls -la'),
          output: text('total 0'),
        },
        2,
        env,
      ),
      hook('hook.stopped', 'm1', { response: text('all done') }, 3, env),
    ];

    it('drops content when the project does not keep it, and never stores it in events', async () => {
      const r = await runner();
      const p = await project(r.runnerId, 'widget', false);
      await r.send(promptAndTool(projectEnvelope('widget')));
      expect(await ctx.prisma.sessionContent.count()).toBe(0);
      const events = await ctx.prisma.event.findMany({
        where: { type: { startsWith: 'hook.' } },
      });
      expect(events).toHaveLength(4);
      expect(JSON.stringify(events.map((e) => e.data))).not.toMatch(
        /my prompt|ls -la|total 0|all done/,
      );
      expect((await sessionRow('m1')).projectId).toBe(p.id);
    });

    it('stores rows when the project keeps content, still not in events, and a resend adds none', async () => {
      const r = await runner();
      await project(r.runnerId, 'widget', true);
      const batch = promptAndTool(projectEnvelope('widget'));
      await r.send(batch);
      const rows = await ctx.prisma.sessionContent.findMany({
        orderBy: [{ at: 'asc' }, { id: 'asc' }],
      });
      expect(
        rows.map((c) => [c.kind, c.text, c.toolUseId, c.toolName]),
      ).toEqual([
        ['prompt', 'my prompt', null, null],
        ['tool_input', 'ls -la', 'tu_1', 'Bash'],
        ['tool_output', 'total 0', 'tu_1', 'Bash'],
        ['response', 'all done', null, null],
      ]);
      const events = await ctx.prisma.event.findMany({
        where: { type: { startsWith: 'hook.' } },
      });
      expect(JSON.stringify(events.map((e) => e.data))).not.toMatch(
        /my prompt|ls -la|total 0|all done/,
      );
      // The same batch again (a resend): no duplicate rows.
      await r.send(batch);
      expect(await ctx.prisma.sessionContent.count()).toBe(4);
    });

    it('stops new rows when the flag goes off and keeps the old ones', async () => {
      const r = await runner();
      const p = await project(r.runnerId, 'widget', true);
      const env = projectEnvelope('widget');
      await r.send([
        hook(
          'hook.prompt_submitted',
          'm1',
          { chars: 1, content: text('first') },
          1,
          env,
        ),
      ]);
      await ctx.prisma.project.update({
        where: { id: p.id },
        data: { shipSessionContent: false },
      });
      await r.send([
        hook(
          'hook.prompt_submitted',
          'm1',
          { chars: 1, content: text('second') },
          2,
          env,
        ),
      ]);
      const rows = await ctx.prisma.sessionContent.findMany();
      expect(rows.map((c) => c.text)).toEqual(['first']);
    });
  });

  describe('GET projects/:projectId/sessions/:id/content (criterion 5)', () => {
    const seed = async () => {
      const r = await runner();
      const a = await project(r.runnerId, 'alpha', true);
      const b = await project(r.runnerId, 'beta', true);
      await r.send([
        hook(
          'hook.prompt_submitted',
          'a1',
          { chars: 1, content: text('in alpha') },
          1,
          projectEnvelope('alpha'),
        ),
        hook(
          'hook.prompt_submitted',
          'b1',
          { chars: 1, content: text('in beta') },
          2,
          projectEnvelope('beta'),
        ),
      ]);
      return { a, b, sa: await sessionRow('a1'), sb: await sessionRow('b1') };
    };
    const url = (projectId: string, sessionId: string, query = '') =>
      `/projects/${projectId}/sessions/${sessionId}/content${query}`;

    it('is 404 for a non-member and rows for a viewer and an operator (ADR-0050)', async () => {
      const { a, sa } = await seed();
      const outsider = await createUser(
        ctx.prisma,
        'out@example.com',
        'viewer',
      );
      expect(outsider).toBeDefined();
      const outsiderSession = await login(ctx, 'out@example.com');
      expect((await outsiderSession.get(url(a.id, sa.id))).status).toBe(404);

      const viewer = await userOn(a.id, 'viewer@example.com');
      const seen = await viewer.session.get(url(a.id, sa.id));
      expect(seen.status).toBe(200);
      expect(
        (seen.body as SessionContentPage).items.map((i) => i.text),
      ).toEqual(['in alpha']);

      const operator = await userOn(a.id, 'op@example.com', 'operator');
      const ok = await operator.session.get(url(a.id, sa.id));
      expect(ok.status).toBe(200);
      const page = ok.body as SessionContentPage;
      expect(page.items.map((i) => i.text)).toEqual(['in alpha']);
      expect(page.nextCursor).toBeNull();
    });

    it("never returns another project's session through this project's route", async () => {
      const { a, sb } = await seed();
      const operator = await userOn(a.id, 'op@example.com', 'operator');
      expect((await operator.session.get(url(a.id, sb.id))).status).toBe(404);
      expect((await admin.get(url(a.id, sb.id))).status).toBe(404);
      expect((await admin.get(url(a.id, 'missing'))).status).toBe(404);
    });

    it('pages by cursor', async () => {
      const r = await runner();
      const p = await project(r.runnerId, 'alpha', true);
      await r.send(
        [1, 2, 3].map((n) =>
          hook(
            'hook.prompt_submitted',
            'a1',
            { chars: 1, content: text(`p${n}`) },
            n,
            projectEnvelope('alpha'),
          ),
        ),
      );
      const s = await sessionRow('a1');
      // The service's page size is a constant; walk it with a cursor from the first row.
      const rows = await ctx.prisma.sessionContent.findMany({
        orderBy: { at: 'asc' },
      });
      const after = await admin.get(
        url(p.id, s.id, `?cursor=${rows[0]?.id.toString()}`),
      );
      expect(
        (after.body as SessionContentPage).items.map((i) => i.text),
      ).toEqual(['p2', 'p3']);
      expect((await admin.get(url(p.id, s.id, '?cursor=abc'))).status).toBe(
        400,
      );
    });

    it('shows hasContent only to operators and admins', async () => {
      const { a } = await seed();
      const viewer = await userOn(a.id, 'viewer@example.com');
      const operator = await userOn(a.id, 'op@example.com', 'operator');
      const flag = async (who: Session) => {
        const response = await who.get(`/sessions?projectId=${a.id}`);
        return (response.body.items as SessionSummary[]).map(
          (s) => s.hasContent,
        );
      };
      expect(await flag(viewer.session)).toEqual([false]);
      expect(await flag(operator.session)).toEqual([true]);
      expect(await flag(admin)).toEqual([true]);
    });

    it('filters the list by origin', async () => {
      const { a } = await seed();
      const manual = await admin.get(
        `/sessions?projectId=${a.id}&origin=manual`,
      );
      expect(manual.body.items).toHaveLength(1);
      const worker = await admin.get(
        `/sessions?projectId=${a.id}&origin=worker`,
      );
      expect(worker.body.items).toHaveLength(0);
      expect((await admin.get('/sessions?origin=bogus')).status).toBe(400);
    });
  });

  describe('purge, retention and project settings (criterion 11)', () => {
    it('purges a project, admin only, and audits the count', async () => {
      const r = await runner();
      const a = await project(r.runnerId, 'alpha', true);
      const b = await project(r.runnerId, 'beta', true);
      await r.send([
        hook(
          'hook.prompt_submitted',
          'a1',
          { chars: 1, content: text('x') },
          1,
          projectEnvelope('alpha'),
        ),
        hook(
          'hook.prompt_submitted',
          'b1',
          { chars: 1, content: text('y') },
          2,
          projectEnvelope('beta'),
        ),
      ]);
      const operator = await userOn(a.id, 'op@example.com', 'operator');
      expect(
        (
          await operator.session.send(
            'delete',
            `/projects/${a.id}/session-content`,
          )
        ).status,
      ).toBe(403);
      expect(await ctx.prisma.sessionContent.count()).toBe(2);

      const response = await admin.send(
        'delete',
        `/projects/${a.id}/session-content`,
      );
      expect(response.status).toBe(204);
      const left = await ctx.prisma.sessionContent.findMany();
      expect(left.map((c) => c.projectId)).toEqual([b.id]);
      const audit = await ctx.prisma.auditRecord.findFirstOrThrow({
        where: { action: 'session_content.purged', projectId: a.id },
      });
      expect(audit).toMatchObject({ projectId: a.id, result: 'ok' });
      expect(audit.after).toMatchObject({ count: 1 });
    });

    it('deletes rows older than the project retention, and only those', async () => {
      const r = await runner();
      const a = await project(r.runnerId, 'alpha', true);
      const b = await project(r.runnerId, 'beta', true);
      await ctx.prisma.project.update({
        where: { id: b.id },
        data: { sessionContentRetentionDays: 90 },
      });
      await r.send(
        ['alpha', 'beta'].map((name) =>
          hook(
            'hook.prompt_submitted',
            name,
            { chars: 1, content: text(name) },
            1,
            projectEnvelope(name),
          ),
        ),
      );
      const day = 24 * 3600 * 1000;
      const old = new Date(Date.now() - 40 * day);
      await ctx.prisma.sessionContent.updateMany({ data: { createdAt: old } });
      const deleted = await ctx.app.get(SessionContentService).sweep();
      expect(deleted).toBe(1);
      const left = await ctx.prisma.sessionContent.findMany();
      expect(left.map((c) => c.projectId)).toEqual([b.id]);
      expect(a.sessionContentRetentionDays).toBe(30);
    });

    it('updates the content settings, audited, validated, and re-pushes the runner config', async () => {
      const r = await runner();
      const p = await project(r.runnerId, 'alpha');
      const response = await admin.send('patch', `/projects/${p.id}`, {
        shipSessionContent: true,
        sessionContentRetentionDays: 7,
      });
      expect(response.status).toBe(200);
      expect(
        await ctx.prisma.project.findUniqueOrThrow({ where: { id: p.id } }),
      ).toMatchObject({
        shipSessionContent: true,
        sessionContentRetentionDays: 7,
      });
      await r.socket.next('config');
      const audit = await ctx.prisma.auditRecord.findFirstOrThrow({
        where: { action: 'project.update', projectId: p.id },
      });
      expect(audit.after).toMatchObject({ shipSessionContent: true });

      for (const days of [0, 366, 1.5]) {
        const bad = await admin.send('patch', `/projects/${p.id}`, {
          sessionContentRetentionDays: days,
        });
        expect(bad.status).toBe(400);
      }
    });
  });

  describe('one request from the transcript and OTel is stored once (criterion 9)', () => {
    const request = (source: 'transcript' | 'otel', s: number, out: number) =>
      transcript(
        'llm.request',
        'm1',
        {
          requestId: 'req_1',
          model: 'claude-opus-5-5',
          tokens: tokens(10, out),
          querySource: 'main',
          source,
          ...(source === 'otel'
            ? { reportedCostUsd: 0.5, durationMs: 900 }
            : {}),
        },
        s,
        source,
      );

    it.each([
      ['transcript first', ['transcript', 'otel'] as const],
      ['OTel first', ['otel', 'transcript'] as const],
    ])('keeps one row, %s', async (_name, order) => {
      const r = await runner();
      const p = await project(r.runnerId, 'widget');
      await r.send([
        transcript(
          'session.observed',
          'm1',
          {
            cwd: '/srv/dev/widget',
            startedAt: at(0),
            parsed: true,
            projectId: p.id,
          },
          0,
        ),
        request(order[0], 1, order[0] === 'transcript' ? 20 : 19),
        request(order[1], 2, order[1] === 'transcript' ? 20 : 19),
      ]);
      const rows = await ctx.prisma.llmRequest.findMany();
      expect(rows).toHaveLength(1);
      // The transcript's token split wins either way.
      expect(rows[0]?.output).toBe(20);
      expect(rows[0]?.input).toBe(10);
    });
  });
});
