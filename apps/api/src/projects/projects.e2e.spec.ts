import type {
  ProjectDetail,
  ProjectErrorBody,
  ProjectMemberView,
  ProjectSummary,
  Role,
} from '@agentdock/shared';
import { allowedLiveOrigin } from '../live/live-options';
import { TestLiveSocket } from '../live/testing/live-e2e';
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
import { FakeRunner, inspection, ROOT } from './testing/projects-e2e';

describe('projects (e2e)', () => {
  let ctx: RunnerE2eContext;
  let admin: Session;
  let runnerId: string;
  let token: string;
  const sockets: { close: () => unknown }[] = [];

  const connectRunner = async (): Promise<FakeRunner> => {
    const socket = new TestRunnerSocket(ctx.origin, token);
    sockets.push(socket);
    await socket.connect();
    return new FakeRunner(socket);
  };

  const connectProject = async (
    path = ROOT,
    body: Record<string, unknown> = {},
  ): Promise<ProjectDetail> => {
    const response = await admin.send('post', '/admin/projects', {
      runnerId,
      path,
      ...body,
    });
    if (response.status !== 201) {
      throw new Error(`connect → ${response.status} ${response.text}`);
    }
    return response.body as ProjectDetail;
  };

  /** A project row straight in the database, for tests that need no runner. */
  const seedProject = (rootPath: string, repo = 'acme/widget') =>
    ctx.prisma.project.create({
      data: {
        runnerId,
        rootPath,
        repo,
        displayName: rootPath.slice(rootPath.lastIndexOf('/') + 1),
        baseBranch: 'main',
        baseSource: 'default',
        hasClaudeMd: false,
        hasAgentsMd: false,
        lastInspectedAt: new Date('2026-01-01T00:00:00Z'),
        docsSource: {
          create: {
            kind: 'none',
            isGitRepo: false,
            evidence: [],
            classified: { specs: [], adr: [], roadmap: [], reports: [] },
            candidates: [],
          },
        },
      },
    });

  const userSession = async (
    email: string,
    role: Role,
  ): Promise<{ id: string; session: Session }> => {
    const user = await createUser(ctx.prisma, email, role);
    return { id: user.id, session: await login(ctx, email) };
  };

  const addMember = (projectId: string, userId: string, roleOverride?: Role) =>
    ctx.prisma.projectMember.create({
      data: { projectId, userId, roleOverride: roleOverride ?? null },
    });

  const auditActions = async (projectId: string) =>
    (
      await ctx.prisma.auditRecord.findMany({
        where: { projectId },
        orderBy: { seq: 'asc' },
      })
    ).map((r) => `${r.action}:${r.result}`);

  beforeAll(async () => {
    ctx = await createRunnerE2eApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    admin = await adminSession(ctx);
    ({ runnerId, token } = await pairedRunner(ctx, admin));
  });
  afterEach(async () => {
    for (const s of sockets.splice(0)) await s.close();
  });

  describe('connect and delete', () => {
    it('previews, connects, pushes the watch list, and drops it again on delete', async () => {
      const runner = await connectRunner();

      const preview = await admin.send('post', '/admin/projects/inspect', {
        runnerId,
        path: ROOT,
      });
      expect(preview.status).toBe(200);
      expect(preview.body).toEqual(inspection());
      expect(await ctx.prisma.project.count()).toBe(0);

      const project = await connectProject(ROOT, { displayName: 'Widget' });
      expect(project).toMatchObject({
        displayName: 'Widget',
        repo: 'acme/widget',
        rootPath: ROOT,
        runnerId,
        runnerStatus: 'online',
        base: 'develop',
        baseSource: 'config',
        docsKind: 'in_repo',
        role: 'admin',
        hasClaudeMd: true,
        codeSentinelConfig: { orchestrator: { base: 'develop' } },
        docsSource: {
          kind: 'in_repo',
          localPath: `${ROOT}/docs`,
          detectedBy: 'in_repo',
          manual: false,
          classified: {
            specs: ['specs'],
            adr: ['adr'],
            roadmap: [],
            reports: [],
          },
        },
      });
      expect(runner.received.map((c) => c.name)).toEqual([
        'project.inspect',
        'project.inspect',
      ]);

      // Pushed to the connected runner, and listed in every later welcome.
      const pushed = await runner.socket.next('config');
      expect(pushed.config.projects).toEqual([{ id: project.id, root: ROOT }]);
      const fresh = new TestRunnerSocket(ctx.origin, token);
      sockets.push(fresh);
      expect((await fresh.connect()).config.projects).toEqual([
        { id: project.id, root: ROOT },
      ]);

      const list = await admin.get('/projects');
      expect((list.body as ProjectSummary[]).map((p) => p.id)).toEqual([
        project.id,
      ]);

      expect(
        (await admin.send('delete', `/admin/projects/${project.id}`)).status,
      ).toBe(204);
      // `fresh` replaced `runner`'s socket, so it gets the push.
      expect((await fresh.next('config')).config.projects).toEqual([]);
      const after = new TestRunnerSocket(ctx.origin, token);
      sockets.push(after);
      expect((await after.connect()).config.projects).toEqual([]);
      expect(await ctx.prisma.docsSource.count()).toBe(0);
      expect((await admin.get(`/projects/${project.id}`)).status).toBe(404);

      expect(await auditActions(project.id)).toEqual([
        'project.connect:ok',
        'project.delete:ok',
      ]);
    });

    it('refuses a worktree with the main checkout suggested', async () => {
      const runner = await connectRunner();
      runner.answer = () => ({
        ok: true,
        output: inspection({ isMainCheckout: false }),
      });
      const response = await admin.send('post', '/admin/projects', {
        runnerId,
        path: '/srv/dev/.wt-widget-i1',
      });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        error: 'not_main_checkout',
        suggestedPath: ROOT,
      } satisfies Partial<ProjectErrorBody>);
      expect(await ctx.prisma.project.count()).toBe(0);
    });

    it('refuses a repository not on GitHub with 422', async () => {
      const runner = await connectRunner();
      runner.answer = () => ({
        ok: true,
        output: inspection({
          remote: {
            url: 'git@gitlab-fwg:team/cockpit.git',
            forge: 'unsupported',
            repo: null,
          },
        }),
      });
      const preview = await admin.send('post', '/admin/projects/inspect', {
        runnerId,
        path: ROOT,
      });
      expect(preview.body.remote.forge).toBe('unsupported');
      const response = await admin.send('post', '/admin/projects', {
        runnerId,
        path: ROOT,
      });
      expect(response.status).toBe(422);
      expect(response.body.error).toBe('unsupported_forge');
    });

    it('refuses the same root on the same runner twice', async () => {
      await connectRunner();
      await connectProject();
      const again = await admin.send('post', '/admin/projects', {
        runnerId,
        path: ROOT,
      });
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('already_connected');
    });

    it('maps runner refusals and absence to HTTP', async () => {
      const offline = await admin.send('post', '/admin/projects/inspect', {
        runnerId,
        path: ROOT,
      });
      expect(offline.status).toBe(409);
      expect(offline.body.error).toBe('runner_offline');

      const runner = await connectRunner();
      const cases = [
        ['path_not_found', 422],
        ['not_a_repository', 422],
        ['path_not_allowed', 403],
        ['internal', 502],
      ] as const;
      for (const [code, status] of cases) {
        runner.answer = () => ({ ok: false, code });
        const response = await admin.send('post', '/admin/projects/inspect', {
          runnerId,
          path: ROOT,
        });
        expect([code, response.status]).toEqual([code, status]);
        expect(response.body.error).toBe(
          code === 'internal' ? 'runner_error' : code,
        );
      }

      const missing = await admin.send('post', '/admin/projects/inspect', {
        runnerId: 'rn_missing',
        path: ROOT,
      });
      expect(missing.status).toBe(404);
      const relative = await admin.send('post', '/admin/projects/inspect', {
        runnerId,
        path: 'dev/widget',
      });
      expect(relative.status).toBe(400);
    });
  });

  describe('authorization', () => {
    it('shows a viewer only member projects and 404s the rest', async () => {
      const a = await seedProject('/srv/a');
      const b = await seedProject('/srv/b');
      const viewer = await userSession('viewer@example.com', 'viewer');
      await addMember(a.id, viewer.id);

      const list = (await viewer.session.get('/projects'))
        .body as ProjectSummary[];
      expect(list.map((p) => [p.id, p.role])).toEqual([[a.id, 'viewer']]);

      expect((await viewer.session.get(`/projects/${a.id}`)).status).toBe(200);
      expect(
        (await viewer.session.get(`/projects/${a.id}/members`)).status,
      ).toBe(200);
      for (const response of [
        await viewer.session.get(`/projects/${b.id}`),
        await viewer.session.get(`/projects/${b.id}/members`),
        await viewer.session.send('post', `/projects/${b.id}/refresh`),
      ]) {
        expect(response.status).toBe(404);
        expect(response.body.error).toBe('not_found');
      }
      // An unknown id answers exactly like an invisible one.
      expect((await viewer.session.get('/projects/prj_nope')).status).toBe(404);
    });

    it('lets an override lower a role but never raise it', async () => {
      const a = await seedProject('/srv/a');
      const operator = await userSession('op@example.com', 'operator');
      const viewer = await userSession('viewer@example.com', 'viewer');
      await addMember(a.id, operator.id, 'viewer');
      await addMember(a.id, viewer.id, 'operator');

      for (const caller of [operator, viewer]) {
        const refresh = await caller.session.send(
          'post',
          `/projects/${a.id}/refresh`,
        );
        expect(refresh.status).toBe(403);
        const shown = (await caller.session.get(`/projects/${a.id}`))
          .body as ProjectDetail;
        expect(shown.role).toBe('viewer');
      }
      const members = (await admin.get(`/projects/${a.id}/members`))
        .body as ProjectMemberView[];
      expect(
        members.map((m) => [m.email, m.roleOverride, m.effectiveRole]),
      ).toEqual([
        ['op@example.com', 'viewer', 'viewer'],
        ['viewer@example.com', 'operator', 'viewer'],
      ]);
    });

    it('keeps every admin route from operators and viewers, members or not', async () => {
      const a = await seedProject('/srv/a');
      const operator = await userSession('op@example.com', 'operator');
      const viewer = await userSession('viewer@example.com', 'viewer');
      await addMember(a.id, operator.id);
      await addMember(a.id, viewer.id);

      const routes: [
        'post' | 'patch' | 'put' | 'delete',
        string,
        object | undefined,
      ][] = [
        ['post', '/admin/projects/inspect', { runnerId, path: ROOT }],
        ['post', '/admin/projects', { runnerId, path: ROOT }],
        ['delete', `/admin/projects/${a.id}`, undefined],
        ['delete', '/admin/projects/prj_nope', undefined],
        ['patch', `/projects/${a.id}`, { displayName: 'x' }],
        ['post', `/projects/${a.id}/members`, { userId: viewer.id }],
        [
          'patch',
          `/projects/${a.id}/members/${viewer.id}`,
          { roleOverride: null },
        ],
        ['delete', `/projects/${a.id}/members/${viewer.id}`, undefined],
        ['put', `/projects/${a.id}/docs-source`, { kind: 'none' }],
        ['delete', `/projects/${a.id}/docs-source`, undefined],
      ];
      for (const caller of [operator, viewer]) {
        for (const [method, path, body] of routes) {
          const response = await caller.session.send(method, path, body);
          expect([method, path, response.status]).toEqual([method, path, 403]);
        }
      }
      expect((await admin.get(`/projects/${a.id}`)).body.displayName).toBe('a');
    });

    it('answers 401 to an anonymous caller', async () => {
      const a = await seedProject('/srv/a');
      for (const path of [
        '/projects',
        `/projects/${a.id}`,
        `/projects/${a.id}/members`,
      ]) {
        expect((await ctx.http().get(path)).status).toBe(401);
      }
      expect(
        (
          await ctx
            .http()
            .post('/admin/projects')
            .send({ runnerId, path: ROOT })
        ).status,
      ).toBe(401);
    });

    it('authorizes `project:<id>` on /live by membership', async () => {
      const a = await seedProject('/srv/a');
      const b = await seedProject('/srv/b');
      const viewer = await userSession('viewer@example.com', 'viewer');
      await addMember(a.id, viewer.id);
      const live = new TestLiveSocket(
        `${ctx.origin.replace(/^http/, 'ws')}/live`,
        { token: viewer.session.token, origin: allowedLiveOrigin() },
      );
      sockets.push({ close: () => live.socket.close() });
      await live.ready();
      expect((await live.subscribe(`project:${a.id}`)).type).toBe('subscribed');
      expect(await live.subscribe(`project:${b.id}`)).toMatchObject({
        type: 'error',
      });
    });
  });

  describe('settings', () => {
    it('accepts only a default profile of the project runner', async () => {
      const a = await seedProject('/srv/a');
      const other = await pairedRunner(ctx, admin, 'other');
      const [own, foreign] = await Promise.all(
        [runnerId, other.runnerId].map((id) =>
          ctx.prisma.runtimeProfile.create({
            data: {
              runnerId: id,
              key: 'claude-main',
              runtime: 'claude',
              label: 'main',
              env: {},
              args: [],
              authenticated: true,
            },
          }),
        ),
      );

      const refused = await admin.send('patch', `/projects/${a.id}`, {
        defaultProfileId: foreign.id,
      });
      expect(refused.status).toBe(422);
      expect(refused.body.error).toBe('profile_not_on_runner');

      const accepted = await admin.send('patch', `/projects/${a.id}`, {
        defaultProfileId: own.id,
        baseOverride: 'release',
        mergeApproval: true,
      });
      expect(accepted.status).toBe(200);
      expect(accepted.body).toMatchObject({
        defaultProfileId: own.id,
        baseOverride: 'release',
        base: 'release',
        mergeApproval: true,
      });
      const cleared = await admin.send('patch', `/projects/${a.id}`, {
        baseOverride: null,
      });
      expect(cleared.body.base).toBe('main');
      expect(await auditActions(a.id)).toEqual([
        'project.update:ok',
        'project.update:ok',
      ]);
    });

    it('refreshes for an operator member and keeps a manual docs source', async () => {
      const runner = await connectRunner();
      const project = await connectProject();
      const operator = await userSession('op@example.com', 'operator');
      await addMember(project.id, operator.id);
      await ctx.prisma.project.update({
        where: { id: project.id },
        data: { lastInspectedAt: new Date('2026-01-01T00:00:00Z') },
      });

      runner.answer = () => ({
        ok: true,
        output: inspection({ baseBranch: 'main', baseSource: 'origin_head' }),
      });
      const refreshed = await operator.session.send(
        'post',
        `/projects/${project.id}/refresh`,
      );
      expect(refreshed.status).toBe(200);
      expect(refreshed.body).toMatchObject({
        baseBranch: 'main',
        baseSource: 'origin_head',
        role: 'operator',
      });
      expect(Date.parse(refreshed.body.lastInspectedAt)).toBeGreaterThan(
        Date.parse('2026-01-02T00:00:00Z'),
      );
      expect(runner.received.at(-1)).toEqual({
        name: 'project.refresh',
        args: { projectId: project.id, root: ROOT },
      });

      const manual = await admin.send(
        'put',
        `/projects/${project.id}/docs-source`,
        { kind: 'sibling_repo', localPath: '/srv/dev/widget-documentation' },
      );
      expect(manual.status).toBe(200);
      expect(manual.body.docsSource).toMatchObject({
        kind: 'sibling_repo',
        localPath: '/srv/dev/widget-documentation',
        manual: true,
        detectedBy: null,
        isGitRepo: false,
      });

      const again = await operator.session.send(
        'post',
        `/projects/${project.id}/refresh`,
      );
      expect(again.body.docsSource).toMatchObject({
        kind: 'sibling_repo',
        manual: true,
      });

      // DELETE restores detection from a fresh inspection.
      const reset = await admin.send(
        'delete',
        `/projects/${project.id}/docs-source`,
      );
      expect(reset.status).toBe(200);
      expect(reset.body.docsSource).toMatchObject({
        kind: 'in_repo',
        detectedBy: 'in_repo',
        manual: false,
      });
      expect(await auditActions(project.id)).toEqual([
        'project.connect:ok',
        'project.docs_source_override:ok',
        'project.docs_source_reset:ok',
      ]);
    });

    it('resends the watch list when the runner does not hold the project', async () => {
      const runner = await connectRunner();
      const project = await connectProject();
      await runner.socket.next('config');
      runner.answer = () => ({ ok: false, code: 'path_not_allowed' });
      const refused = await admin.send(
        'post',
        `/projects/${project.id}/refresh`,
      );
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe('path_not_allowed');
      expect((await runner.socket.next('config')).config.projects).toEqual([
        { id: project.id, root: ROOT },
      ]);
    });

    it('validates a docs-source override against its kind', async () => {
      const a = await seedProject('/srv/a');
      const bad = [
        { kind: 'in_repo', localPath: '/elsewhere/docs' },
        { kind: 'in_repo' },
        { kind: 'remote_repo' },
        { kind: 'remote_repo', repo: 'acme/docs', localPath: '/srv/docs' },
        { kind: 'none', repo: 'acme/docs' },
        { kind: 'sibling_repo' },
      ];
      for (const body of bad) {
        const response = await admin.send(
          'put',
          `/projects/${a.id}/docs-source`,
          body,
        );
        expect([body, response.status]).toEqual([body, 422]);
      }
      const remote = await admin.send('put', `/projects/${a.id}/docs-source`, {
        kind: 'remote_repo',
        repo: 'acme/widget-docs',
      });
      expect(remote.body.docsSource).toMatchObject({
        kind: 'remote_repo',
        repo: 'acme/widget-docs',
        localPath: null,
        isGitRepo: true,
      });
      const offline = await admin.send(
        'delete',
        `/projects/${a.id}/docs-source`,
      );
      expect(offline.status).toBe(409);
      expect(offline.body.error).toBe('runner_offline');
      const stored = await ctx.prisma.docsSource.findUnique({
        where: { projectId: a.id },
      });
      expect(stored?.manual).toBe(true);
    });
  });

  describe('members', () => {
    it('adds, changes and removes members, refusing what it must', async () => {
      const a = await seedProject('/srv/a');
      const operator = await userSession('op@example.com', 'operator');
      const pending = await createUser(
        ctx.prisma,
        'pending@example.com',
        'viewer',
        'pending',
      );

      const notFound = await admin.send('post', `/projects/${a.id}/members`, {
        userId: 'usr_nope',
      });
      expect([notFound.status, notFound.body.error]).toEqual([
        422,
        'user_not_found',
      ]);
      const inactive = await admin.send('post', `/projects/${a.id}/members`, {
        userId: pending.id,
      });
      expect([inactive.status, inactive.body.error]).toEqual([
        422,
        'user_not_active',
      ]);

      const added = await admin.send('post', `/projects/${a.id}/members`, {
        userId: operator.id,
      });
      expect(added.status).toBe(201);
      expect(added.body).toMatchObject({
        userId: operator.id,
        globalRole: 'operator',
        roleOverride: null,
        effectiveRole: 'operator',
      });
      const twice = await admin.send('post', `/projects/${a.id}/members`, {
        userId: operator.id,
      });
      expect([twice.status, twice.body.error]).toEqual([409, 'already_member']);

      const lowered = await admin.send(
        'patch',
        `/projects/${a.id}/members/${operator.id}`,
        { roleOverride: 'viewer' },
      );
      expect(lowered.body.effectiveRole).toBe('viewer');
      expect((await operator.session.get(`/projects/${a.id}`)).body.role).toBe(
        'viewer',
      );

      expect(
        (await admin.send('delete', `/projects/${a.id}/members/${operator.id}`))
          .status,
      ).toBe(204);
      expect((await operator.session.get(`/projects/${a.id}`)).status).toBe(
        404,
      );
      expect(
        (await admin.send('delete', `/projects/${a.id}/members/${operator.id}`))
          .status,
      ).toBe(404);

      expect(await auditActions(a.id)).toEqual([
        'project.member_add:ok',
        'project.member_update:ok',
        'project.member_remove:ok',
      ]);

      // Deleting the admin who added a member keeps the membership.
      await addMember(a.id, operator.id);
      const other = await createUser(ctx.prisma, 'a2@example.com', 'admin');
      await ctx.prisma.projectMember.updateMany({
        where: { projectId: a.id },
        data: { addedById: other.id },
      });
      await ctx.prisma.user.delete({ where: { id: other.id } });
      expect(
        await ctx.prisma.projectMember.findMany({ where: { projectId: a.id } }),
      ).toEqual([expect.objectContaining({ addedById: null })]);
    });
  });
});
