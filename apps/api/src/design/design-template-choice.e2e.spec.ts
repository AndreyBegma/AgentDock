import type { PlanDetail, TaskDesignView } from '@nautelle/shared';
import { decomposed, task } from '../planner/testing/planner-e2e';
import { DesignHarness } from './testing/design-e2e';

const ui = (template?: string) => ({
  design: {
    needed: true,
    why: 'A new screen.',
    variants: 1,
    ...(template ? { template } : {}),
  },
});

/** #833 D8: who chooses a design's template — the planner suggests, a person wins. */
describe('design template choice (e2e, #833)', () => {
  const h = new DesignHarness();

  beforeAll(() => h.start());
  afterAll(() => h.ctx.app.close());
  beforeEach(() => h.reset());
  afterEach(() => jest.restoreAllMocks());

  const plan = (template?: string): Promise<PlanDetail> =>
    decomposed(h, [task('t1', ui(template))]);
  const view = async (planId: string) =>
    (await h.author.get(h.designBase(planId, 't1'))).body as TaskDesignView;
  const stored = (planId: string) =>
    h.ctx.prisma.taskDesign.findFirstOrThrow({
      where: { planId, taskKey: 't1' },
      select: { templateKey: true, templateSource: true },
    });

  it("takes the planner's suggested template as auto, and drops one the project lacks", async () => {
    await h.seedProfile();
    const flow = await plan('flow');
    expect(await stored(flow.id)).toEqual({
      templateKey: 'flow',
      templateSource: 'auto',
    });
    expect((await view(flow.id)).template.key).toBe('flow');

    const unknown = await plan('landing');
    expect((await stored(unknown.id)).templateKey).toBeNull();
    expect((await view(unknown.id)).template.key).toBe('page');
  });

  it("a person's templateKey on a task is theirs, and a later suggestion keeps it", async () => {
    await h.seedProfile();
    const p = await plan('flow');
    const patched = await h.author.send('patch', h.designBase(p.id, 't1'), {
      templateKey: 'component',
    });
    expect(patched.status).toBe(200);
    expect(await stored(p.id)).toEqual({
      templateKey: 'component',
      templateSource: 'person',
    });
    expect((await view(p.id)).template.key).toBe('component');
  });

  it('refuses a key the project does not have, and a viewer', async () => {
    await h.seedProfile();
    const p = await plan();
    const base = h.designBase(p.id, 't1');
    const unknown = await h.author.send('patch', base, {
      templateKey: 'landing',
    });
    expect(unknown.status).toBe(400);
    expect(
      (await h.author.send('patch', base, { templateKey: 'Not A Key' })).status,
    ).toBe(400);
    expect(
      (await h.viewer.send('patch', base, { templateKey: 'flow' })).status,
    ).toBe(403);
    await h.ctx.prisma.designTemplate.create({
      data: {
        projectId: p.projectId,
        key: 'landing',
        name: 'Landing',
        definition: {
          frames: [
            {
              key: 'hero',
              kind: 'custom',
              name: 'Hero',
              instruction: 'Draw the hero.',
              required: true,
              enabled: true,
            },
          ],
        },
      },
    });
    expect(
      (await h.author.send('patch', base, { templateKey: 'landing' })).status,
    ).toBe(200);
  });

  it("another project's plan is 404", async () => {
    await h.seedProfile();
    const p = await plan();
    expect(
      (
        await h.outsider.send('patch', h.designBase(p.id, 't1'), {
          templateKey: 'flow',
        })
      ).status,
    ).toBe(404);
  });
});
