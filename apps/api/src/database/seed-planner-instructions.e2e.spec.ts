import { createE2eApp, type E2eContext } from '../test/e2e-app';
import {
  readDefaultPlannerInstructions,
  seedPlannerInstructions,
} from './seed-planner-instructions';

describe('planner instructions seed (e2e)', () => {
  let ctx: E2eContext;

  beforeAll(async () => {
    ctx = await createE2eApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(() =>
    ctx.prisma.$executeRawUnsafe('TRUNCATE TABLE planner_instructions CASCADE'),
  );

  it('seeds global version 1 from default-instructions.md, once', async () => {
    expect(await seedPlannerInstructions(ctx.prisma)).toEqual({
      created: true,
    });
    expect(await seedPlannerInstructions(ctx.prisma)).toEqual({
      created: false,
    });
    const rows = await ctx.prisma.plannerInstructions.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId: null,
      version: 1,
      authorId: null,
      body: readDefaultPlannerInstructions(),
    });
    expect(rows[0].body).toContain('# Planner instructions');
  });

  it('leaves an edited global version alone', async () => {
    await ctx.prisma.plannerInstructions.create({
      data: { projectId: null, version: 2, body: 'edited' },
    });
    expect(await seedPlannerInstructions(ctx.prisma)).toEqual({
      created: false,
    });
    expect(await ctx.prisma.plannerInstructions.count()).toBe(1);
  });

  it('refuses a second global row with the same version', async () => {
    await seedPlannerInstructions(ctx.prisma);
    await expect(
      ctx.prisma.plannerInstructions.create({
        data: { projectId: null, version: 1, body: 'duplicate' },
      }),
    ).rejects.toThrow();
  });
});
