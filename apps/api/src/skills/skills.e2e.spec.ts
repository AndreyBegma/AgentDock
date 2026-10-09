import {
  type CommandRunView,
  runTopic,
  SKILL_PREVIEW_TTL_MS,
  type SkillInspectView,
  type SkillRunDetail,
  type SkillRunView,
} from '@agentdock/shared';
import type {
  InstalledSkill,
  RunnerEvent,
  SkillCommandName,
} from '@agentdock/shared/protocol';
import { seedProject } from '../fleet/testing/fleet-e2e';
import { allowedLiveOrigin } from '../live/live-options';
import {
  createLiveE2eApp,
  type LiveE2eContext,
  TestLiveSocket,
} from '../live/testing/live-e2e';
import { RunnerEventSinks } from '../runners/runner-event-sinks';
import {
  createUser,
  login,
  resetDatabase,
  type Session,
} from '../test/e2e-app';
import { SkillCommands, type SkillSendResult } from './skill-commands';
import { SkillInstallService } from './skill-install.service';

const ROOT_A = '/srv/dev/widget';
const ROOT_B = '/srv/dev/gadget';
const COMMIT = 'a'.repeat(40);
const HASH = 'b'.repeat(64);
const FILE_HASH = 'c'.repeat(64);

type Handler = (args: unknown) => SkillSendResult<SkillCommandName>;
const ok = <T>(output: T) => ({ status: 'ok' as const, output });
const fail = (code: string, message?: string) =>
  ({
    status: 'error' as const,
    error: { code, ...(message ? { message } : {}) },
  }) as SkillSendResult<SkillCommandName>;

const inspection = {
  commit: COMMIT,
  skills: [
    {
      skillId: 'estimate',
      path: 'skills/estimate',
      frontmatter: { name: 'estimate', description: 'Estimates work' },
      files: [{ path: 'SKILL.md', size: 120, sha256: FILE_HASH }],
      contentHash: HASH,
    },
    {
      skillId: 'review',
      path: 'skills/review',
      frontmatter: { name: 'review', 'allowed-tools': ['Read'] },
      files: [{ path: 'SKILL.md', size: 80, sha256: FILE_HASH }],
      contentHash: 'd'.repeat(64),
    },
  ],
};

describe('skills (e2e)', () => {
  let ctx: LiveE2eContext;
  let sinks: RunnerEventSinks;
  let commands: SkillCommands;
  let installs: SkillInstallService;
  let runnerId: string;
  let otherRunnerId: string;
  let a: string;
  let b: string;
  let admin: Session;
  let viewerOfA: Session;
  let operatorOfA: Session;
  let operatorOfB: Session;
  let outsider: Session;
  let handlers: Partial<Record<SkillCommandName, Handler>>;
  let seq: number;
  const sockets: TestLiveSocket[] = [];

  const memberOf = async (
    email: string,
    projectId: string | null,
    role: 'viewer' | 'operator',
  ) => {
    const user = await createUser(ctx.prisma, email, role);
    if (projectId) {
      await ctx.prisma.projectMember.create({
        data: { projectId, userId: user.id },
      });
    }
    return login(ctx, email);
  };

  const sent = (name: SkillCommandName) =>
    jest
      .mocked(commands.send)
      .mock.calls.filter(([, n]) => n === name)
      .map(([runner, , args, options]) => ({ runner, args, options }));

  const event = (type: string, data: object): RunnerEvent => {
    seq += 1;
    return {
      v: 1,
      seq,
      ts: new Date(Date.UTC(2026, 9, 9, 12, 0, seq)).toISOString(),
      type,
      source: 'runner',
      project: { repo: 'acme/widget', root: ROOT_A },
      data,
    };
  };

  /** The audit chain is append-only: each test reads only what it added. */
  let auditFrom = 0n;
  const auditOf = (action: string) =>
    ctx.prisma.auditRecord.findMany({
      where: { seq: { gt: auditFrom }, action },
      orderBy: { seq: 'asc' },
    });

  const skill = (overrides: Partial<InstalledSkill>): InstalledSkill =>
    ({
      scope: 'project',
      runtime: 'claude',
      name: 'estimate',
      invocation: 'estimate',
      path: '.claude/skills/estimate',
      projectId: a,
      ...overrides,
    }) as InstalledSkill;

  const startRun = async (
    session = operatorOfA,
    project = a,
    body: object = {},
  ) =>
    session.send('post', `/projects/${project}/skill-runs`, {
      skill: 'estimate',
      args: 'issue 24',
      model: 'opus',
      output: 'report',
      ...body,
    });

  const inspect = async (session = operatorOfA, body: object = {}) => {
    const response = await session.send('post', '/skills/inspect', {
      runnerId,
      source: 'acme/skills',
      ...body,
    });
    expect(response.status).toBe(201);
    return response.body as SkillInspectView;
  };

  beforeAll(async () => {
    ctx = await createLiveE2eApp();
    sinks = ctx.app.get(RunnerEventSinks);
    commands = ctx.app.get(SkillCommands);
    installs = ctx.app.get(SkillInstallService);
  });
  afterAll(async () => {
    for (const socket of sockets) socket.socket.close();
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    ({ runnerId, projectId: a } = await seedProject(ctx.prisma, ROOT_A));
    ({ projectId: b } = await seedProject(ctx.prisma, ROOT_B, runnerId));
    ({ runnerId: otherRunnerId } = await seedProject(
      ctx.prisma,
      '/srv/dev/other',
    ));
    await ctx.prisma.runtimeProfile.createMany({
      data: [
        {
          runnerId,
          key: 'claude-main',
          runtime: 'claude',
          label: 'Claude',
          env: {},
          args: [],
          authenticated: true,
        },
        {
          runnerId,
          key: 'codex-main',
          runtime: 'codex',
          label: 'Codex',
          env: {},
          args: [],
          authenticated: true,
        },
      ],
    });
    const main = await ctx.prisma.runtimeProfile.findFirstOrThrow({
      where: { key: 'claude-main' },
    });
    await ctx.prisma.project.updateMany({
      where: { id: { in: [a, b] } },
      data: { defaultProfileId: main.id },
    });
    await ctx.prisma.installedSkill.createMany({
      data: [
        {
          runnerId,
          projectId: a,
          scope: 'project',
          runtime: 'claude',
          name: 'estimate',
          invocation: 'estimate',
          path: '.claude/skills/estimate',
          seenAt: new Date(),
        },
        {
          runnerId,
          projectId: b,
          scope: 'project',
          runtime: 'claude',
          name: 'estimate',
          invocation: 'estimate',
          path: '.claude/skills/estimate',
          seenAt: new Date(),
        },
        {
          runnerId,
          profileKey: 'claude-main',
          scope: 'plugin',
          runtime: 'claude',
          name: 'orchestrator',
          invocation: 'code-sentinel:orchestrator',
          path: '/p/orchestrator',
          pluginVersion: '1.0.0',
          seenAt: new Date(),
        },
      ],
    });
    await createUser(ctx.prisma, 'admin@example.com', 'admin');
    admin = await login(ctx, 'admin@example.com');
    viewerOfA = await memberOf('viewer-a@example.com', a, 'viewer');
    operatorOfA = await memberOf('operator-a@example.com', a, 'operator');
    operatorOfB = await memberOf('operator-b@example.com', b, 'operator');
    outsider = await memberOf('outsider@example.com', null, 'operator');
    seq = 0;
    const last = await ctx.prisma.auditRecord.findFirst({
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    auditFrom = last?.seq ?? 0n;

    handlers = {
      'skill.search': () =>
        ok({
          items: [
            {
              id: 'acme/skills/estimate',
              source: 'acme/skills',
              skillId: 'estimate',
              name: 'estimate',
              installs: 42,
            },
          ],
        }),
      'skill.inspect': () => ok(inspection),
      'skill.install': (args) => {
        const target = (args as { target: { scope: string } }).target;
        return target.scope === 'project'
          ? ok({
              path: '.claude/skills/estimate',
              prUrl: 'https://github.com/acme/widget/pull/7',
            })
          : ok({ path: '/home/u/.claude/skills/estimate' });
      },
      'skill.uninstall': () => ok({ removed: true }),
      'skill.list': () => ok({ items: [] }),
      'skill.run': () => ok({ phase: 'queued' }),
      'skill.cancel': () => ok({ cancelled: true }),
    };
    jest.spyOn(commands, 'assertReady').mockImplementation(() => undefined);
    jest
      .spyOn(commands, 'send')
      .mockImplementation(async (_runner, name, args) => {
        const handler = handlers[name];
        if (!handler) throw new Error(`no handler for ${name}`);
        return handler(args) as never;
      });
  });
  afterEach(async () => {
    await installs.settled();
    jest.restoreAllMocks();
  });

  describe('authorization', () => {
    const projectRoutes = (project: string, runId: string) =>
      [
        ['get', `/projects/${project}/skills`],
        ['post', `/projects/${project}/skills/refresh`],
        ['post', `/projects/${project}/skills/install`],
        ['post', `/projects/${project}/skill-runs`],
        ['post', `/projects/${project}/skill-runs/${runId}/cancel`],
        ['get', `/projects/${project}/skill-runs/${runId}`],
      ] as const;

    it('answers 404 to a non-member on every project skills route', async () => {
      const runId = ((await startRun()).body as SkillRunView).runId;
      for (const session of [outsider, operatorOfB]) {
        for (const [method, path] of projectRoutes(a, runId)) {
          const response =
            method === 'get'
              ? await session.get(path)
              : await session.send(method, path, {});
          expect([path, response.status]).toEqual([path, 404]);
        }
      }
    });

    it('answers 403 to a viewer on install, refresh, run and cancel, and sends nothing', async () => {
      const runId = ((await startRun()).body as SkillRunView).runId;
      jest.mocked(commands.send).mockClear();
      for (const [method, path] of projectRoutes(a, runId)) {
        if (method === 'get') continue;
        const response = await viewerOfA.send(method, path, {});
        expect([path, response.status]).toEqual([path, 403]);
      }
      expect(commands.send).not.toHaveBeenCalled();
      expect((await viewerOfA.get(`/projects/${a}/skills`)).status).toBe(200);
      expect(
        (await viewerOfA.get(`/projects/${a}/skill-runs/${runId}`)).status,
      ).toBe(200);
    });

    it("does not let an operator of A cancel B's run through A's route", async () => {
      const response = await startRun(operatorOfB, b);
      expect(response.status).toBe(201);
      const runId = (response.body as SkillRunView).runId;

      const cancel = await operatorOfA.send(
        'post',
        `/projects/${a}/skill-runs/${runId}/cancel`,
      );
      expect(cancel.status).toBe(404);
      expect(
        (await operatorOfA.get(`/projects/${a}/skill-runs/${runId}`)).status,
      ).toBe(404);
      expect(sent('skill.cancel')).toHaveLength(0);
    });

    it('lets a member of B subscribe to run:<B>:<runId> and refuses everyone else', async () => {
      const runId = ((await startRun(operatorOfB, b)).body as SkillRunView)
        .runId;
      const socketOf = async (session: Session) => {
        const socket = new TestLiveSocket(ctx.liveUrl, {
          token: session.token,
          origin: allowedLiveOrigin(),
        });
        sockets.push(socket);
        return socket.ready();
      };
      const topic = runTopic(b, runId);

      expect(await (await socketOf(operatorOfA)).subscribe(topic)).toEqual({
        type: 'error',
        topic,
        code: 'forbidden',
      });
      expect(await (await socketOf(outsider)).subscribe(topic)).toEqual({
        type: 'error',
        topic,
        code: 'forbidden',
      });
      const member = await socketOf(operatorOfB);
      expect(await member.subscribe(topic)).toEqual({
        type: 'subscribed',
        topic,
      });
      const unknown = runTopic(b, 'no-such-run');
      expect(await member.subscribe(unknown)).toEqual({
        type: 'error',
        topic: unknown,
        code: 'not_found',
      });
      // A run of A is not a run of B.
      const runOfA = ((await startRun()).body as SkillRunView).runId;
      const crossed = runTopic(b, runOfA);
      expect(await member.subscribe(crossed)).toEqual({
        type: 'error',
        topic: crossed,
        code: 'not_found',
      });
    });

    it('answers 404 on the catalog to a caller with no project on the runner, 403 to a viewer', async () => {
      const path = `/skills/catalog?q=estimate&runnerId=${runnerId}`;
      expect((await outsider.get(path)).status).toBe(404);
      expect((await viewerOfA.get(path)).status).toBe(403);
      expect(
        (await operatorOfA.get(`/skills/catalog?q=x&runnerId=${otherRunnerId}`))
          .status,
      ).toBe(404);
      expect(commands.send).not.toHaveBeenCalled();

      const response = await operatorOfA.get(path);
      expect(response.status).toBe(200);
      expect(response.body.items).toEqual([
        expect.objectContaining({ source: 'acme/skills', installs: 42 }),
      ]);
      expect(sent('skill.search')[0].args).toEqual({ query: 'estimate' });
    });

    it('refuses a profile install to an operator with 403, audited, without consuming the preview', async () => {
      const { previews } = await inspect();
      const response = await operatorOfA.send(
        'post',
        `/runners/${runnerId}/profiles/claude-main/skills/install`,
        { previewId: previews[0].previewId, runtime: 'claude' },
      );
      expect(response.status).toBe(403);
      expect(sent('skill.install')).toHaveLength(0);
      const denied = await auditOf('skill.installed');
      expect(denied).toEqual([expect.objectContaining({ result: 'denied' })]);
      const preview = await ctx.prisma.skillInstallPreview.findUniqueOrThrow({
        where: { id: previews[0].previewId },
      });
      expect(preview.consumedAt).toBeNull();
      expect(
        (
          await operatorOfA.send(
            'delete',
            `/runners/${runnerId}/profiles/claude-main/skills/claude/estimate`,
          )
        ).status,
      ).toBe(403);
    });

    it('rejects a catalog query or inspect source carrying a host or URL', async () => {
      const response = await operatorOfA.send('post', '/skills/inspect', {
        runnerId,
        source: 'https://evil.example/acme/skills',
      });
      expect(response.status).toBe(400);
      const withHost = await operatorOfA.send('post', '/skills/inspect', {
        runnerId,
        source: 'acme/skills',
        host: 'evil.example',
      });
      expect(withHost.status).toBe(400);
      const dotdot = await operatorOfA.send('post', '/skills/inspect', {
        runnerId,
        source: 'acme/..',
        skillId: '..',
      });
      expect(dotdot.status).toBe(400);
      expect(commands.send).not.toHaveBeenCalled();
    });
  });

  describe('inspect and install', () => {
    it('stores one preview per skill, owned by the caller, for 15 minutes', async () => {
      const before = Date.now();
      const { commit, previews } = await inspect();
      expect(commit).toBe(COMMIT);
      expect(previews.map((p) => [p.skillId, p.contentHash, p.path])).toEqual([
        ['estimate', HASH, 'skills/estimate'],
        ['review', 'd'.repeat(64), 'skills/review'],
      ]);
      expect(previews[0].files).toEqual(inspection.skills[0].files);
      expect(previews[1].frontmatter['allowed-tools']).toEqual(['Read']);
      const expires = Date.parse(previews[0].expiresAt) - before;
      expect(expires).toBeGreaterThanOrEqual(SKILL_PREVIEW_TTL_MS - 1000);
      expect(expires).toBeLessThanOrEqual(SKILL_PREVIEW_TTL_MS + 5000);
      expect(sent('skill.inspect')[0].args).toEqual({ source: 'acme/skills' });
    });

    it('installs into the project as a command run that ends with the PR, audited, then rescans', async () => {
      const { previews } = await inspect();
      const response = await operatorOfA.send(
        'post',
        `/projects/${a}/skills/install`,
        { previewId: previews[0].previewId, runtime: 'claude' },
      );
      expect(response.status).toBe(202);
      const run = response.body as CommandRunView;
      expect(run).toMatchObject({
        command: 'skill.install',
        status: 'requested',
      });
      await installs.settled();

      expect(sent('skill.install')[0].args).toEqual({
        source: 'acme/skills',
        skillId: 'estimate',
        commit: COMMIT,
        contentHash: HASH,
        target: {
          scope: 'project',
          projectId: a,
          root: ROOT_A,
          base: 'develop',
          runtime: 'claude',
        },
      });
      const finished = await ctx.prisma.commandRun.findUniqueOrThrow({
        where: { id: run.id },
      });
      expect(finished.status).toBe('ok');
      expect(finished.result).toEqual({
        path: '.claude/skills/estimate',
        prUrl: 'https://github.com/acme/widget/pull/7',
      });
      expect(await auditOf('skill.installed')).toEqual([
        expect.objectContaining({ result: 'ok', projectId: a }),
      ]);
      expect(sent('skill.list')[0].args).toEqual({
        projectId: a,
        root: ROOT_A,
      });

      const again = await operatorOfA.send(
        'post',
        `/projects/${a}/skills/install`,
        { previewId: previews[0].previewId, runtime: 'claude' },
      );
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('preview_consumed');
    });

    it('records changed_since_preview as a failed install and keeps the preview consumed', async () => {
      handlers['skill.install'] = () =>
        fail('changed_since_preview', 'content moved');
      const { previews } = await inspect();
      const response = await operatorOfA.send(
        'post',
        `/projects/${a}/skills/install`,
        { previewId: previews[0].previewId, runtime: 'claude' },
      );
      expect(response.status).toBe(202);
      await installs.settled();
      const run = await ctx.prisma.commandRun.findUniqueOrThrow({
        where: { id: (response.body as CommandRunView).id },
      });
      expect(run.status).toBe('error');
      expect(run.error).toMatchObject({
        message: expect.stringContaining('changed_since_preview'),
      });
      expect(await auditOf('skill.installed')).toEqual([
        expect.objectContaining({ result: 'error' }),
      ]);
      expect(sent('skill.list')).toHaveLength(0);
      const preview = await ctx.prisma.skillInstallPreview.findUniqueOrThrow({
        where: { id: previews[0].previewId },
      });
      expect(preview.consumedAt).not.toBeNull();
    });

    it("refuses another user's, another runner's and an expired preview", async () => {
      const { previews } = await inspect();
      const install = (session: Session, project = a) =>
        session.send('post', `/projects/${project}/skills/install`, {
          previewId: previews[0].previewId,
          runtime: 'claude',
        });
      expect((await install(admin)).status).toBe(404);
      await ctx.prisma.skillInstallPreview.update({
        where: { id: previews[0].previewId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const expired = await install(operatorOfA);
      expect(expired.status).toBe(410);
      expect(expired.body.error).toBe('preview_expired');
      expect(sent('skill.install')).toHaveLength(0);
    });

    it('installs into a profile for an admin and rescans the runner', async () => {
      const { previews } = await inspect(admin);
      const response = await admin.send(
        'post',
        `/runners/${runnerId}/profiles/claude-main/skills/install`,
        { previewId: previews[0].previewId, runtime: 'claude' },
      );
      expect(response.status).toBe(201);
      expect(response.body).toEqual({
        path: '/home/u/.claude/skills/estimate',
      });
      expect(sent('skill.install')[0].args).toMatchObject({
        target: {
          scope: 'profile',
          profileKey: 'claude-main',
          runtime: 'claude',
        },
      });
      expect(sent('skill.install')[0].options.role).toBe('admin');
      expect(sent('skill.list')[0].args).toEqual({});

      const uninstall = await admin.send(
        'delete',
        `/runners/${runnerId}/profiles/claude-main/skills/claude/estimate`,
      );
      expect(uninstall.status).toBe(200);
      expect(sent('skill.uninstall')[0].args).toEqual({
        profileKey: 'claude-main',
        runtime: 'claude',
        name: 'estimate',
      });
      expect(await auditOf('skill.uninstalled')).toEqual([
        expect.objectContaining({ result: 'ok' }),
      ]);
    });

    it('answers 503 command_unavailable while the runner has no skill handlers, and creates nothing', async () => {
      jest.mocked(commands.assertReady).mockRestore();
      jest.mocked(commands.send).mockRestore();
      const response = await startRun();
      expect(response.status).toBe(503);
      expect(response.body.error).toBe('command_unavailable');
      expect(await ctx.prisma.run.count()).toBe(0);
    });
  });

  describe('inventory', () => {
    it('replaces what a scan covers, and lists project, profile and plugin skills', async () => {
      handlers['skill.list'] = () =>
        ok({
          items: [
            skill({
              name: 'triage',
              invocation: 'triage',
              path: '.claude/skills/triage',
            }),
            // Another project's row is dropped: only A was scanned.
            skill({ projectId: b, name: 'sneaky', invocation: 'sneaky' }),
            skill({
              scope: 'profile',
              projectId: undefined,
              profileKey: 'claude-main',
              name: 'notes',
              invocation: 'notes',
              path: '/home/u/.claude/skills/notes',
              source: 'acme/skills',
              commit: COMMIT,
              contentHash: HASH,
            }),
            skill({
              scope: 'plugin',
              projectId: undefined,
              profileKey: 'claude-main',
              name: 'spec',
              invocation: 'code-sentinel:spec',
              plugin: 'code-sentinel',
              pluginVersion: '2.0.0',
              path: '/p/spec',
            }),
            skill({
              scope: 'plugin',
              projectId: undefined,
              profileKey: 'claude-main',
              name: 'orchestrator',
              invocation: 'code-sentinel:orchestrator',
              plugin: 'code-sentinel',
              pluginVersion: '2.0.0',
              path: '/p/orchestrator',
            }),
          ],
        });
      const response = await operatorOfA.send(
        'post',
        `/projects/${a}/skills/refresh`,
      );
      expect(response.status).toBe(200);

      const list = await viewerOfA.get(`/projects/${a}/skills`);
      expect(list.status).toBe(200);
      const items = list.body.items as {
        scope: string;
        invocation: string;
        runnable: boolean;
        source: string | null;
      }[];
      expect(
        items.map((i) => [i.scope, i.invocation, i.runnable]).sort(),
      ).toEqual(
        [
          ['plugin', 'code-sentinel:orchestrator', false],
          ['plugin', 'code-sentinel:spec', true],
          ['profile', 'notes', true],
          ['project', 'triage', true],
        ].sort(),
      );
      expect(items.find((i) => i.invocation === 'notes')?.source).toBe(
        'acme/skills',
      );
      expect(list.body.scannedAt).toEqual(expect.any(String));
      // B's own row is untouched by A's scan.
      expect(
        await ctx.prisma.installedSkill.count({ where: { projectId: b } }),
      ).toBe(1);
    });
  });

  describe('runs', () => {
    it('creates a runs row of kind skill and its skill_runs row, sends skill.run and audits', async () => {
      const response = await startRun();
      expect(response.status).toBe(201);
      const view = response.body as SkillRunView;
      expect(view).toMatchObject({
        skill: 'estimate',
        args: 'issue 24',
        profileKey: 'claude-main',
        model: 'opus',
        permissionMode: 'auto',
        output: 'report',
        phase: 'queued',
        status: 'running',
        timeoutSec: 3600,
      });
      const run = await ctx.prisma.run.findUniqueOrThrow({
        where: { id: view.runId },
      });
      expect(run).toMatchObject({
        kind: 'skill',
        projectId: a,
        status: 'running',
        triggeredByType: 'user',
        runtime: 'claude',
        output: 'report',
      });
      expect(sent('skill.run')[0].args).toEqual({
        runId: view.runId,
        projectId: a,
        root: ROOT_A,
        base: 'develop',
        skill: 'estimate',
        args: 'issue 24',
        profileKey: 'claude-main',
        model: 'opus',
        permissionMode: 'auto',
        output: 'report',
        timeoutSec: 3600,
      });
      expect(await auditOf('skill.run_started')).toEqual([
        expect.objectContaining({ result: 'ok', projectId: a }),
      ]);
    });

    it('takes the permission mode from the project orchestrator settings and keeps bypass for admins', async () => {
      await ctx.prisma.projectOrchestratorSettings.create({
        data: { projectId: a, permissionMode: 'acceptEdits' },
      });
      const view = (await startRun()).body as SkillRunView;
      expect(view.permissionMode).toBe('acceptEdits');

      const bypass = await startRun(operatorOfA, a, {
        permissionMode: 'bypassPermissions',
      });
      expect(bypass.status).toBe(403);
      expect(await auditOf('skill.run_started')).toContainEqual(
        expect.objectContaining({ result: 'denied' }),
      );
      expect(
        (await startRun(admin, a, { permissionMode: 'bypassPermissions' }))
          .status,
      ).toBe(201);
    });

    it('refuses the orchestrator skill, a codex profile and an unknown skill before anything is sent', async () => {
      const orchestrator = await startRun(operatorOfA, a, {
        skill: 'code-sentinel:orchestrator',
      });
      expect(orchestrator.status).toBe(422);
      expect(orchestrator.body.error).toBe('not_runnable');

      const codex = await startRun(operatorOfA, a, {
        profileKey: 'codex-main',
      });
      expect(codex.status).toBe(422);
      expect(codex.body.error).toBe('unsupported_runtime');

      const unknown = await startRun(operatorOfA, a, { skill: 'nope' });
      expect(unknown.status).toBe(404);
      expect(unknown.body.error).toBe('skill_not_found');

      expect(commands.send).not.toHaveBeenCalled();
      expect(await ctx.prisma.run.count()).toBe(0);
    });

    it('fails the run when the runner refuses it, and keeps it queued when the runner does not answer', async () => {
      handlers['skill.run'] = () => fail('not_runnable', 'refused');
      const refused = await startRun();
      expect(refused.status).toBe(422);
      const failed = await ctx.prisma.skillRun.findUniqueOrThrow({
        where: { runId: refused.body.runId },
        include: { run: true },
      });
      expect(failed.phase).toBe('failed');
      expect(failed.run.status).toBe('failed');

      handlers['skill.run'] = () => ({ status: 'unknown' });
      const silent = await startRun();
      expect(silent.status).toBe(504);
      const queued = await ctx.prisma.skillRun.findUniqueOrThrow({
        where: { runId: silent.body.runId },
        include: { run: true },
      });
      expect(queued.phase).toBe('queued');
      expect(queued.run.status).toBe('running');
    });

    it('stays queued until the runner reports progress, then stores the D10 report on finish', async () => {
      const { runId } = (await startRun()).body as SkillRunView;
      const detail = async () => {
        const response = await viewerOfA.get(
          `/projects/${a}/skill-runs/${runId}`,
        );
        expect(response.status).toBe(200);
        return response.body as SkillRunDetail;
      };
      expect((await detail()).phase).toBe('queued');

      await sinks.dispatch(runnerId, [
        event('skill_run.phase_changed', {
          runId,
          projectId: a,
          phase: 'running',
          at: '2026-10-09T12:00:10.000Z',
          tmuxSession: 'agentdock-run-abc123',
          worktree: '/srv/dev/.wt-widget-run-abc123',
          branch: 'run/abc123-estimate',
        }),
      ]);
      const running = await detail();
      expect(running).toMatchObject({
        phase: 'running',
        status: 'running',
        tmuxSession: 'agentdock-run-abc123',
        worktree: '/srv/dev/.wt-widget-run-abc123',
      });

      const finished = event('skill_run.finished', {
        runId,
        projectId: a,
        phase: 'succeeded',
        finishedAt: '2026-10-09T12:05:00.000Z',
        exitCode: 0,
        reportText: 'Estimate: M\nDetails follow',
        reportTruncated: false,
        changedFiles: [{ status: ' M', path: 'README.md' }],
        changedFilesTotal: 1,
        patch: 'diff --git a/README.md b/README.md\n',
        patchTruncated: false,
      });
      await sinks.dispatch(runnerId, [finished]);
      // A replayed batch changes nothing and audits once.
      await sinks.dispatch(runnerId, [finished]);

      const done = await detail();
      expect(done).toMatchObject({
        phase: 'succeeded',
        status: 'succeeded',
        exitCode: 0,
        reportText: 'Estimate: M\nDetails follow',
        changedFiles: [{ status: ' M', path: 'README.md' }],
        changedFilesTotal: 1,
        patch: 'diff --git a/README.md b/README.md\n',
      });
      expect(done.run).toMatchObject({
        kind: 'skill',
        status: 'succeeded',
        outcome: 'Estimate: M',
      });
      expect(await auditOf('skill.run_finished')).toHaveLength(1);

      // A late phase never reopens a finished run.
      await sinks.dispatch(runnerId, [
        event('skill_run.phase_changed', {
          runId,
          projectId: a,
          phase: 'running',
          at: '2026-10-09T12:06:00.000Z',
        }),
      ]);
      expect((await detail()).phase).toBe('succeeded');
    });

    it('maps cancelled to abandoned and timed_out to failed', async () => {
      const cancelled = ((await startRun()).body as SkillRunView).runId;
      const response = await operatorOfA.send(
        'post',
        `/projects/${a}/skill-runs/${cancelled}/cancel`,
      );
      expect(response.status).toBe(200);
      expect(sent('skill.cancel')[0].args).toEqual({
        runId: cancelled,
        projectId: a,
      });
      expect(await auditOf('skill.run_cancelled')).toEqual([
        expect.objectContaining({ result: 'ok' }),
      ]);

      const timedOut = ((await startRun()).body as SkillRunView).runId;
      const end = (runId: string, phase: string) =>
        event('skill_run.finished', {
          runId,
          projectId: a,
          phase,
          finishedAt: '2026-10-09T13:00:00.000Z',
          exitCode: null,
          reportTruncated: false,
          changedFiles: [],
          changedFilesTotal: 0,
          patchTruncated: false,
        });
      await sinks.dispatch(runnerId, [
        end(cancelled, 'cancelled'),
        end(timedOut, 'timed_out'),
      ]);
      const status = async (id: string) =>
        (await ctx.prisma.run.findUniqueOrThrow({ where: { id } })).status;
      expect(await status(cancelled)).toBe('abandoned');
      expect(await status(timedOut)).toBe('failed');

      const again = await operatorOfA.send(
        'post',
        `/projects/${a}/skill-runs/${cancelled}/cancel`,
      );
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('run_finished');
    });

    it('ignores skill run events from another runner, or naming another project', async () => {
      const { runId } = (await startRun()).body as SkillRunView;
      const changed = (projectId: string) =>
        event('skill_run.phase_changed', {
          runId,
          projectId,
          phase: 'running',
          at: '2026-10-09T12:00:10.000Z',
        });
      await sinks.dispatch(otherRunnerId, [changed(a)]);
      await sinks.dispatch(runnerId, [changed(b)]);
      const row = await ctx.prisma.skillRun.findUniqueOrThrow({
        where: { runId },
      });
      expect(row.phase).toBe('queued');
    });
  });
});
