import type {
  ProjectRuleImportResult,
  ProjectRuleView,
} from '@agentdock/shared';
import { seedProject } from '../fleet/testing/fleet-e2e';
import {
  createE2eApp,
  createUser,
  type E2eContext,
  login,
  resetDatabase,
  type Session,
} from '../test/e2e-app';

const ROOT_A = '/srv/dev/widget';
const ROOT_B = '/srv/dev/gadget';

describe('project rules (e2e, #528)', () => {
  let ctx: E2eContext;
  let a: string;
  let b: string;
  let admin: Session;
  let operatorOfA: Session;
  let viewerOfA: Session;

  const memberOf = async (
    email: string,
    projectId: string,
    role: 'viewer' | 'operator',
  ) => {
    const user = await createUser(ctx.prisma, email, role);
    await ctx.prisma.projectMember.create({
      data: { projectId, userId: user.id },
    });
    return login(ctx, email);
  };

  const path = (projectId = a, rest = '') =>
    `/projects/${projectId}/rules${rest}`;

  const create = async (title: string, projectId = a) => {
    const response = await admin.send('post', path(projectId), { title });
    expect(response.status).toBe(201);
    return response.body as ProjectRuleView;
  };

  beforeAll(async () => {
    ctx = await createE2eApp();
  });
  afterAll(() => ctx.app.close());

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await ctx.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE runners, projects CASCADE',
    );
    let runnerId: string;
    ({ runnerId, projectId: a } = await seedProject(ctx.prisma, ROOT_A));
    ({ projectId: b } = await seedProject(ctx.prisma, ROOT_B, runnerId));
    await createUser(ctx.prisma, 'admin@example.com', 'admin');
    admin = await login(ctx, 'admin@example.com');
    operatorOfA = await memberOf('operator@example.com', a, 'operator');
    viewerOfA = await memberOf('viewer@example.com', a, 'viewer');
  });

  it('creates, lists, updates, reorders and deletes rules', async () => {
    const x = await create('Use Bun');
    const y = await create('Biome only');

    const patched = await admin.send('patch', path(a, `/${x.id}`), {
      description: 'Never npm install.',
      enabled: false,
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      title: 'Use Bun',
      description: 'Never npm install.',
      enabled: false,
    });

    const reordered = await admin.send('put', path(a, '/order'), {
      ruleIds: [y.id, x.id],
    });
    expect(reordered.status).toBe(200);
    expect(
      (reordered.body as ProjectRuleView[]).map((r) => [r.id, r.position]),
    ).toEqual([
      [y.id, 0],
      [x.id, 1],
    ]);

    expect((await admin.send('delete', path(a, `/${y.id}`))).status).toBe(204);
    const list = await viewerOfA.get(path());
    expect(list.status).toBe(200);
    expect(list.body).toEqual([
      expect.objectContaining({ id: x.id, position: 0, source: 'manual' }),
    ]);
  });

  it('rejects an empty title and unknown fields', async () => {
    const x = await create('Use Bun');
    for (const body of [
      { title: '' },
      { title: '   ' },
      { title: 'T', position: 4 },
      {},
    ]) {
      expect((await admin.send('post', path(), body)).status).toBe(400);
    }
    expect(
      (await admin.send('patch', path(a, `/${x.id}`), { title: '' })).status,
    ).toBe(400);
    expect(
      (await admin.send('patch', path(a, `/${x.id}`), { source: 'scanned' }))
        .status,
    ).toBe(400);
    expect(
      (await admin.send('put', path(a, '/order'), { ruleIds: [x.id, 'nope'] }))
        .status,
    ).toBe(409);
  });

  it('imports Markdown and reports created and skipped counts', async () => {
    await create('Use Bun');
    const markdown = '# Rules\n## use bun\nx\n## Strict TS\nNo any.\n';

    const first = await admin.send('post', path(a, '/import'), { markdown });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      created: 1,
      skipped: 1,
      skippedTitles: ['use bun'],
    } satisfies Partial<ProjectRuleImportResult>);
    expect((first.body as ProjectRuleImportResult).rules).toEqual([
      expect.objectContaining({
        title: 'Strict TS',
        description: 'No any.',
        enabled: true,
        position: 1,
        source: 'imported',
      }),
    ]);

    const again = await admin.send('post', path(a, '/import'), { markdown });
    expect(again.body).toMatchObject({ created: 0, skipped: 2 });
  });

  it('lets members read, only a project admin write, and hides other projects', async () => {
    const x = await create('Use Bun');
    const ofB = await create('B rule', b);

    expect((await operatorOfA.get(path())).status).toBe(200);
    for (const session of [operatorOfA, viewerOfA]) {
      const writes = [
        session.send('post', path(), { title: 'T' }),
        session.send('patch', path(a, `/${x.id}`), { enabled: false }),
        session.send('delete', path(a, `/${x.id}`)),
        session.send('put', path(a, '/order'), { ruleIds: [x.id] }),
        session.send('post', path(a, '/import'), { markdown: '- A' }),
      ];
      for (const response of await Promise.all(writes)) {
        expect(response.status).toBe(403);
      }
    }
    expect((await viewerOfA.get(path(b))).status).toBe(404);
    expect(
      (await admin.send('patch', path(a, `/${ofB.id}`), { enabled: false }))
        .status,
    ).toBe(404);
  });

  it('deletes the rules with their project', async () => {
    await create('Use Bun');
    await ctx.prisma.project.delete({ where: { id: a } });
    expect(
      await ctx.prisma.projectRule.count({ where: { projectId: a } }),
    ).toBe(0);
  });
});
