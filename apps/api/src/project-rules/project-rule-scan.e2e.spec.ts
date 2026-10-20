import type {
  ProjectDetail,
  ProjectRuleImportResult,
  ProjectRuleScanResult,
  ProjectRuleView,
} from '@nautelle/shared';
import type { ProjectScanRulesResult } from '@nautelle/shared/protocol';
import { FakeRunner, inspection, ROOT } from '../projects/testing/projects-e2e';
import {
  adminSession,
  capabilities,
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

const scanned: ProjectScanRulesResult = {
  candidates: [
    {
      title: 'Use Bun',
      description: 'Never `npm install`.',
      source: 'CLAUDE.md',
    },
    {
      title: 'Strict TypeScript',
      description: 'No `any`.',
      source: 'tsconfig.json',
    },
    { title: 'Squash merges', description: '', source: 'CONTRIBUTING.md' },
  ],
  scanned: ['CLAUDE.md', 'CONTRIBUTING.md', 'tsconfig.json'],
  warnings: ['AGENTS.md is larger than 256 KB; skipped.'],
};

describe('coding rule scan (e2e, #584)', () => {
  let ctx: RunnerE2eContext;
  let admin: Session;
  let runnerId: string;
  let token: string;
  const sockets: { close: () => unknown }[] = [];

  const connectRunner = async (commands?: string[]): Promise<FakeRunner> => {
    const socket = new TestRunnerSocket(ctx.origin, token);
    sockets.push(socket);
    await socket.connect(
      commands
        ? hello({ capabilities: { ...capabilities, commands } })
        : undefined,
    );
    const runner = new FakeRunner(socket);
    runner.answer = ({ name }) =>
      name === 'project.scan_rules'
        ? { ok: true, output: scanned }
        : { ok: true, output: inspection() };
    return runner;
  };

  const connectProject = async (): Promise<ProjectDetail> => {
    const response = await admin.send('post', '/admin/projects', {
      runnerId,
      path: ROOT,
    });
    expect(response.status).toBe(201);
    return response.body as ProjectDetail;
  };

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

  it('scans before connect, creates only the accepted candidates, and rescans without duplicates', async () => {
    const runner = await connectRunner();

    // The connect dialog: candidates come back, nothing is stored.
    const preview = await admin.send(
      'post',
      '/admin/projects/rule-candidates',
      {
        runnerId,
        path: ROOT,
      },
    );
    expect(preview.status).toBe(200);
    expect(preview.body).toEqual({
      candidates: scanned.candidates.map((c) => ({ ...c, duplicate: false })),
      scanned: scanned.scanned,
      warnings: scanned.warnings,
    } satisfies ProjectRuleScanResult);
    expect(runner.received).toContainEqual({
      name: 'project.scan_rules',
      args: { path: ROOT },
    });
    expect(await ctx.prisma.project.count()).toBe(0);
    expect(await ctx.prisma.projectRule.count()).toBe(0);

    // Connect, then accept two of the three.
    const project = await connectProject();
    expect(await ctx.prisma.projectRule.count()).toBe(0);
    const [bun, strict] = scanned.candidates;
    const accepted = await admin.send(
      'post',
      `/projects/${project.id}/rules/accept`,
      { candidates: [bun, strict] },
    );
    expect(accepted.status).toBe(201);
    const result = accepted.body as ProjectRuleImportResult;
    expect(result).toMatchObject({ created: 2, skipped: 0 });
    expect(
      result.rules.map((r) => [r.title, r.enabled, r.position, r.source]),
    ).toEqual([
      ['Use Bun', true, 0, 'scanned'],
      ['Strict TypeScript', true, 1, 'scanned'],
    ]);
    // ADR-0027: each new rule's text went to normalization.
    const requests = await ctx.prisma.textNormalization.findMany({
      where: { projectId: project.id },
    });
    expect(requests.map((r) => [r.ownerType, r.ruleId]).sort()).toEqual(
      result.rules.map((r) => ['project_rule', r.id]).sort(),
    );

    // The Rules screen's rescan marks what is already a rule.
    const rescan = await admin.send(
      'post',
      `/projects/${project.id}/rules/scan`,
    );
    expect(rescan.status).toBe(200);
    expect(
      (rescan.body as ProjectRuleScanResult).candidates.map((c) => [
        c.title,
        c.duplicate,
      ]),
    ).toEqual([
      ['Use Bun', true],
      ['Strict TypeScript', true],
      ['Squash merges', false],
    ]);

    // Accepting a taken title again creates nothing.
    const again = await admin.send(
      'post',
      `/projects/${project.id}/rules/accept`,
      { candidates: scanned.candidates },
    );
    expect(again.body).toMatchObject({
      created: 1,
      skipped: 2,
      skippedTitles: ['Use Bun', 'Strict TypeScript'],
    });
    const rules = await admin.get(`/projects/${project.id}/rules`);
    expect((rules.body as ProjectRuleView[]).map((r) => r.title)).toEqual([
      'Use Bun',
      'Strict TypeScript',
      'Squash merges',
    ]);
  });

  it('keeps scanning and accepting to project admins', async () => {
    await connectRunner();
    const project = await connectProject();
    const operator = await createUser(
      ctx.prisma,
      'operator@example.com',
      'operator',
    );
    await ctx.prisma.projectMember.create({
      data: { projectId: project.id, userId: operator.id },
    });
    const session = await login(ctx, 'operator@example.com');

    expect(
      (await session.send('post', `/projects/${project.id}/rules/scan`)).status,
    ).toBe(403);
    expect(
      (
        await session.send('post', `/projects/${project.id}/rules/accept`, {
          candidates: [scanned.candidates[0]],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await session.send('post', '/admin/projects/rule-candidates', {
          runnerId,
          path: ROOT,
        })
      ).status,
    ).toBe(403);
    expect(await ctx.prisma.projectRule.count()).toBe(0);
  });

  it('refuses a runner that does not serve the scan, sending nothing (ADR-0023)', async () => {
    const runner = await connectRunner(['project.inspect', 'project.refresh']);

    const response = await admin.send(
      'post',
      '/admin/projects/rule-candidates',
      { runnerId, path: ROOT },
    );

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: 'runner_outdated' });
    expect(runner.received.map((c) => c.name)).not.toContain(
      'project.scan_rules',
    );
  });

  it('answers runner_offline when the runner is not connected', async () => {
    const response = await admin.send(
      'post',
      '/admin/projects/rule-candidates',
      { runnerId, path: ROOT },
    );
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: 'runner_offline' });
  });
});
