import type { ProjectReadinessView } from '@nautelle/shared';
import { PlannerHarness } from '../planner/testing/planner-e2e';

/** #272 D3, D4: `GET /projects/:projectId/readiness`. */
describe('project readiness (e2e)', () => {
  const h = new PlannerHarness();

  beforeAll(() => h.start());
  afterAll(() => h.ctx.app.close());
  beforeEach(async () => {
    await h.reset();
    // A project every action can run in: a spec dir and session content.
    await h.ctx.prisma.project.update({
      where: { id: h.projectId },
      data: {
        codeSentinelConfig: { orchestrator: { specDir: 'docs/specs' } },
        shipSessionContent: true,
      },
    });
  });

  const path = () => `/projects/${h.projectId}/readiness`;
  const read = async (session = h.viewer) => {
    const response = await session.get(path());
    expect(response.status).toBe(200);
    return response.body as ProjectReadinessView;
  };

  const ALL_CLEAR = {
    design: [],
    run: [],
    capture: [],
    spec_on_run: [],
    plan: [],
  };

  it('a ready project has no blockers, names its profile, and a viewer may read it', async () => {
    expect(await read()).toEqual({
      profile: { key: 'claude-main', label: 'Claude', source: 'default' },
      suggestion: expect.objectContaining({ key: 'claude-main' }),
      actions: ALL_CLEAR,
    });
  });

  it('is 404 to a non-member', async () => {
    expect((await h.outsider.get(path())).status).toBe(404);
  });

  it('lists no_profile on every model action, with the suggestion an admin can use', async () => {
    await h.ctx.prisma.project.update({
      where: { id: h.projectId },
      data: { defaultProfileId: null },
    });
    const main = await h.ctx.prisma.runtimeProfile.findFirstOrThrow({
      where: { key: 'claude-main' },
    });
    const view = await read();
    const none = [{ code: 'no_profile', reason: 'none', source: null }];
    expect(view).toEqual({
      profile: null,
      // The runner's only usable Claude profile; the Codex one is not offered.
      suggestion: { id: main.id, key: 'claude-main', label: 'Claude' },
      actions: {
        design: none,
        run: none,
        capture: none,
        spec_on_run: [],
        plan: none,
      },
    });
  });

  it('names an unusable profile with its reason and source', async () => {
    const codex = await h.ctx.prisma.runtimeProfile.findFirstOrThrow({
      where: { key: 'codex-main' },
    });
    await h.ctx.prisma.projectOrchestratorSettings.create({
      data: { projectId: h.projectId, profileId: codex.id },
    });
    const view = await read();
    expect(view.profile).toEqual({
      key: 'codex-main',
      label: 'Codex',
      source: 'orchestrator',
    });
    expect(view.actions.run).toEqual([
      {
        code: 'no_profile',
        reason: 'not_claude',
        source: 'orchestrator',
        profileKey: 'codex-main',
      },
    ]);
  });

  it('lists runner_offline on every model action when the runner is disconnected', async () => {
    jest.mocked(h.presence.isConnected).mockReturnValue(false);
    const offline = [{ code: 'runner_offline' }];
    expect((await read()).actions).toEqual({
      design: offline,
      run: offline,
      capture: offline,
      spec_on_run: [],
      plan: offline,
    });
  });

  it('lists runner_outdated with the commands the advert lacks, per action', async () => {
    h.advert = {
      commands: ['plan.turn', 'card.run', 'worktree.status'],
      disabled: [],
    };
    expect((await read()).actions).toEqual({
      design: [{ code: 'runner_outdated', commands: ['uiprofile.build'] }],
      run: [],
      capture: [{ code: 'runner_outdated', commands: ['cards.extract'] }],
      spec_on_run: [],
      plan: [],
    });
  });

  it('lists no_spec_dir on spec_on_run and content_off on capture', async () => {
    await h.ctx.prisma.project.update({
      where: { id: h.projectId },
      data: { codeSentinelConfig: {}, shipSessionContent: false },
    });
    expect((await read()).actions).toEqual({
      ...ALL_CLEAR,
      capture: [{ code: 'content_off' }],
      spec_on_run: [{ code: 'no_spec_dir' }],
    });
  });
});
