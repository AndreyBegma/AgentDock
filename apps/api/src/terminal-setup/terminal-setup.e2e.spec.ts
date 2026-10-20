import type {
  SessionOrigin,
  TerminalSetupItem,
  TerminalSetupView,
} from '@nautelle/shared';
import { PlannerHarness } from '../planner/testing/planner-e2e';

/** #281 D2, D3, D5: `GET /projects/:projectId/terminal-setup`. */
describe('terminal setup (e2e)', () => {
  const h = new PlannerHarness();
  let externalId = 0;

  beforeAll(() => h.start());
  afterAll(() => h.ctx.app.close());
  beforeEach(async () => {
    await h.reset();
    externalId = 0;
  });

  const path = () => `/projects/${h.projectId}/terminal-setup`;
  const read = async (session = h.viewer) => {
    const response = await session.get(path());
    expect(response.status).toBe(200);
    return response.body as TerminalSetupView;
  };
  const plugins = (view: TerminalSetupView) =>
    view.items.filter((item) => item.id === 'plugin');
  const stateOf = (items: TerminalSetupItem[], profileKey: string) =>
    items.find((item) => item.profileKey === profileKey)?.state;

  const session = (
    profileKey: string | null,
    origin: SessionOrigin,
    startedAt = new Date(Date.now() - 60 * 60 * 1000),
  ) => {
    externalId += 1;
    return h.ctx.prisma.agentSession.create({
      data: {
        runnerId: h.runnerId,
        runtime: 'claude',
        profileKey,
        externalId: `ext-${externalId}`,
        projectId: h.projectId,
        cwd: '/srv/dev/widget',
        startedAt,
        lastEventAt: startedAt,
        origin,
      },
    });
  };

  it('lists the default profile with no sessions as unknown, and a viewer may read it', async () => {
    const view = await read();
    expect(plugins(view).map((p) => [p.profileKey, p.state])).toEqual([
      ['claude-main', 'unknown'],
    ]);
    expect(view.complete).toBe(false);
  });

  it('is 404 to a non-member', async () => {
    expect((await h.outsider.get(path())).status).toBe(404);
  });

  it('counts hooked and unhooked sessions per profile (D2)', async () => {
    await session('claude-main', 'manual');
    await session('claude-main', 'manual');
    await session('claude-extra', 'unknown');
    // Not evidence: another origin, outside the window, or no profile.
    await session('claude-main', 'worker');
    await session('claude-old', 'unknown', new Date('2026-01-01T00:00:00Z'));
    await session(null, 'unknown');

    const view = await read();
    expect(plugins(view).map((p) => [p.profileKey, p.state])).toEqual([
      ['claude-main', 'done'],
      ['claude-extra', 'todo'],
    ]);
  });

  it('lists the orchestrator profile and the profiles of card runs (D3)', async () => {
    const codex = await h.ctx.prisma.runtimeProfile.findFirstOrThrow({
      where: { key: 'codex-main' },
    });
    await h.ctx.prisma.projectOrchestratorSettings.create({
      data: { projectId: h.projectId, profileId: codex.id },
    });
    await h.ctx.prisma.run.create({
      data: {
        kind: 'card',
        projectId: h.projectId,
        profileKey: 'claude-card',
        status: 'succeeded',
        triggeredByType: 'user',
        updatedAt: new Date(),
        startedAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
    // A card run older than the window is not listed.
    await h.ctx.prisma.run.create({
      data: {
        kind: 'card',
        projectId: h.projectId,
        profileKey: 'claude-ancient',
        status: 'succeeded',
        triggeredByType: 'user',
        updatedAt: new Date(),
        startedAt: new Date('2026-01-01T00:00:00Z'),
      },
    });

    const view = await read();
    expect(plugins(view).map((p) => p.profileKey)).toEqual([
      'claude-main',
      'codex-main',
      'claude-card',
    ]);
    // Codex is listed and never a blocker.
    expect(plugins(view)[1]).toMatchObject({ optional: true });
  });

  it("takes D1 from the runner's stored capabilities", async () => {
    await h.ctx.prisma.runner.update({
      where: { id: h.runnerId },
      data: {
        capabilities: {
          profiles: [
            {
              id: 'claude-main',
              agentdock: { plugin: null, telemetry: false },
            },
          ],
        },
      },
    });
    let view = await read();
    expect(stateOf(plugins(view), 'claude-main')).toBe('todo');

    await h.ctx.prisma.runner.update({
      where: { id: h.runnerId },
      data: {
        capabilities: {
          profiles: [
            {
              id: 'claude-main',
              agentdock: { plugin: '0.4.0', telemetry: true },
            },
          ],
        },
      },
    });
    view = await read();
    expect(stateOf(plugins(view), 'claude-main')).toBe('done');
  });

  it('lists the profiles the runner reports and the project does not use as other, optional profiles (#719)', async () => {
    await h.ctx.prisma.project.update({
      where: { id: h.projectId },
      data: { defaultProfileId: null },
    });
    await h.ctx.prisma.runner.update({
      where: { id: h.runnerId },
      data: {
        capabilities: {
          profiles: [
            {
              id: 'claude-alpha',
              runtime: 'claude',
              agentdock: { plugin: null, telemetry: false },
            },
            { id: 'claude-beta', runtime: 'claude' },
            { id: 'codex-gamma', runtime: 'codex' },
          ],
        },
      },
    });
    const view = await read();
    expect(view.otherProfiles.map((p) => [p.profileKey, p.state])).toEqual([
      ['claude-alpha', 'todo'],
      ['claude-beta', 'unknown'],
    ]);
    expect(view.otherProfiles.every((p) => p.optional)).toBe(true);
    const alpha = view.otherProfiles[0];
    expect(
      alpha.steps.flatMap((s) => (s.kind === 'command' ? [s.code] : [])),
    ).toContain('agentdock-runner setup claude --profile claude-alpha');
    // The project uses none of them: the checklist asks for the key instead.
    expect(plugins(view)).toHaveLength(1);
    expect(plugins(view)[0].profileKey).toBeUndefined();
  });

  describe('profiles the project does not use (#719)', () => {
    const report = (...profiles: { id: string; plugin: string | null }[]) =>
      h.ctx.prisma.runner.update({
        where: { id: h.runnerId },
        data: {
          capabilities: {
            profiles: profiles.map(({ id, plugin }) => ({
              id,
              runtime: 'claude',
              agentdock: { plugin, telemetry: true },
            })),
          },
        },
      });
    const done = async () => {
      await h.ctx.prisma.project.update({
        where: { id: h.projectId },
        data: { shipSessionContent: true },
      });
      await h.ctx.prisma.boardSettings.create({
        data: { projectId: h.projectId, captureEnabled: true },
      });
    };
    const ignore = (profileKey: string, ignored = true, session = h.admin) =>
      session.send('put', `${path()}/ignored-profiles`, {
        profileKey,
        ignored,
      });

    it('a reported profile without the plugin adds no required step', async () => {
      await done();
      await report(
        { id: 'claude-main', plugin: '0.4.0' },
        { id: 'claude-hatkom', plugin: null },
      );
      const view = await read();
      expect(plugins(view).map((p) => p.profileKey)).toEqual(['claude-main']);
      expect(view.otherProfiles.map((p) => [p.profileKey, p.state])).toEqual([
        ['claude-hatkom', 'todo'],
      ]);
      expect(view.todo).toBe(0);
      expect(view.complete).toBe(true);
    });

    it('the default profile without the plugin is still a required step', async () => {
      await done();
      await report(
        { id: 'claude-main', plugin: null },
        { id: 'claude-hatkom', plugin: null },
      );
      const view = await read();
      expect(stateOf(plugins(view), 'claude-main')).toBe('todo');
      expect(view.todo).toBe(1);
    });

    it('a profile that ran a session in the last 30 days counts; an older one does not', async () => {
      await done();
      await report(
        { id: 'claude-main', plugin: '0.4.0' },
        { id: 'claude-recent', plugin: null },
        { id: 'claude-stale', plugin: null },
      );
      await session(
        'claude-recent',
        'manual',
        new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      );
      await session(
        'claude-stale',
        'manual',
        new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      );
      const view = await read();
      expect(plugins(view).map((p) => p.profileKey)).toEqual([
        'claude-main',
        'claude-recent',
      ]);
      expect(view.otherProfiles.map((p) => p.profileKey)).toEqual([
        'claude-stale',
      ]);
      expect(view.todo).toBe(1);
    });

    it('an ignored profile leaves the checklist and the other profiles, and comes back', async () => {
      await done();
      await report(
        { id: 'claude-main', plugin: null },
        { id: 'claude-hatkom', plugin: null },
      );
      expect((await read()).todo).toBe(1);

      let response = await ignore('claude-main');
      expect(response.status).toBe(200);
      response = await ignore('claude-hatkom');
      let view = response.body as TerminalSetupView;
      expect(view.ignoredProfileKeys).toEqual(['claude-main', 'claude-hatkom']);
      expect(plugins(view).some((p) => p.profileKey === 'claude-main')).toBe(
        false,
      );
      expect(view.otherProfiles).toEqual([]);
      expect(view.todo).toBe(0);
      expect(await read()).toEqual(view);

      const runner = await h.ctx.prisma.runner.findUniqueOrThrow({
        where: { id: h.runnerId },
      });
      expect(runner.ignoredProfileKeys).toEqual([
        'claude-main',
        'claude-hatkom',
      ]);
      const audits = await h.ctx.prisma.auditRecord.count({
        where: { action: 'runner.update', targetId: h.runnerId },
      });
      expect(audits).toBe(2);

      response = await ignore('claude-main', false);
      view = response.body as TerminalSetupView;
      expect(view.ignoredProfileKeys).toEqual(['claude-hatkom']);
      expect(stateOf(plugins(view), 'claude-main')).toBe('todo');
      expect(view.todo).toBe(1);
    });

    it('is a project admin’s, and validates the body', async () => {
      expect((await ignore('claude-main', true, h.viewer)).status).toBe(403);
      expect((await ignore('claude-main', true, h.author)).status).toBe(403);
      expect((await ignore('claude-main', true, h.outsider)).status).toBe(404);
      expect((await ignore('two words')).status).toBe(400);
      expect(
        (
          await h.admin.send('put', `${path()}/ignored-profiles`, {
            profileKey: 'claude-main',
          })
        ).status,
      ).toBe(400);
    });
  });

  it('emits one unknown plugin item with the listing steps when nothing is known', async () => {
    await h.ctx.prisma.project.update({
      where: { id: h.projectId },
      data: { defaultProfileId: null },
    });
    const view = await read();
    expect(plugins(view)).toHaveLength(1);
    expect(plugins(view)[0]).toMatchObject({ state: 'unknown' });
    expect(plugins(view)[0].profileKey).toBeUndefined();
    expect(
      plugins(view)[0].steps.flatMap((s) =>
        s.kind === 'command' ? [s.code] : [],
      ),
    ).toEqual([
      'agentdock-runner profiles',
      'agentdock-runner setup claude --profile <key>',
    ]);
  });

  it('flags plugin_loaded for sessions that started after the runner last reported', async () => {
    const reported = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await h.ctx.prisma.runner.update({
      where: { id: h.runnerId },
      data: {
        lastSeenAt: reported,
        capabilities: {
          profiles: [
            {
              id: 'claude-main',
              agentdock: { plugin: '0.4.0', telemetry: true },
            },
          ],
        },
      },
    });
    // Started before the report: it may predate the install, not counted.
    await session(
      'claude-main',
      'unknown',
      new Date(reported.getTime() - 60 * 60 * 1000),
    );
    let view = await read();
    expect(view.items.find((item) => item.id === 'plugin_loaded')?.state).toBe(
      'done',
    );

    await session('claude-main', 'unknown');
    view = await read();
    expect(view.items.find((item) => item.id === 'plugin_loaded')?.state).toBe(
      'todo',
    );
  });

  it('reads content and capture from the project, capture blocked by content', async () => {
    let view = await read();
    const capture = () => view.items.find((item) => item.id === 'capture');
    const content = () => view.items.find((item) => item.id === 'content');
    expect(content()?.state).toBe('todo');
    expect(capture()).toMatchObject({ state: 'todo', blockedBy: 'content' });

    await h.ctx.prisma.project.update({
      where: { id: h.projectId },
      data: { shipSessionContent: true },
    });
    await h.ctx.prisma.boardSettings.create({
      data: { projectId: h.projectId, captureEnabled: true },
    });
    view = await read();
    expect(content()?.state).toBe('done');
    expect(capture()?.state).toBe('done');
  });
});
