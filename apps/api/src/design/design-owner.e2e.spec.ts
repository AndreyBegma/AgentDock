import { seedProject } from '../fleet/testing/fleet-e2e';
import {
  createE2eApp,
  createUser,
  type E2eContext,
  resetDatabase,
} from '../test/e2e-app';

/**
 * ADR-0025: a design has exactly one owner — a plan task or a board card —
 * and a plan turn belongs to a plan or to a card. The database refuses the
 * rest (`task_designs_owner_check`, `plan_turns_owner_check`), whatever the
 * code above it does.
 */
describe('design owner CHECKs (e2e, #243)', () => {
  let ctx: E2eContext;
  let planId: string;
  let cardId: string;
  let runId: () => Promise<string>;

  beforeAll(async () => {
    ctx = await createE2eApp();
  });
  afterAll(() => ctx.app.close());

  beforeEach(async () => {
    const { prisma } = ctx;
    await resetDatabase(prisma);
    const { projectId } = await seedProject(prisma, '/srv/dev/widget');
    const author = await createUser(prisma, 'author@example.com', 'operator');
    const instructions = await prisma.plannerInstructions.create({
      data: { projectId: null, version: 1, body: 'INSTRUCTIONS' },
    });
    planId = (
      await prisma.plan.create({
        data: {
          projectId,
          authorId: author.id,
          title: 'Plan',
          contractVersion: 2,
          brief: 'Build it',
          mode: 'batch',
          status: 'drafting',
          sessionId: '00000000-0000-4000-8000-000000000001',
          instructionsId: instructions.id,
          profileKey: 'claude-main',
          model: 'opus',
        },
      })
    ).id;
    cardId = (
      await prisma.boardCard.create({
        data: {
          projectId,
          number: 1,
          shortId: 'abcd1234',
          title: 'Add login',
          position: 1,
          issueOnRun: false,
          specOnRun: false,
          movedAt: new Date(),
        },
      })
    ).id;
    runId = async () =>
      (
        await prisma.run.create({
          data: {
            kind: 'plan',
            projectId,
            title: 'Design',
            runtime: 'claude',
            model: 'opus',
            profileKey: 'claude-main',
            args: {},
            status: 'running',
            triggeredByType: 'user',
            startedAt: new Date(),
            updatedAt: new Date(),
          },
          select: { id: true },
        })
      ).id;
  });

  const refused = async (write: Promise<unknown>): Promise<string> => {
    try {
      await write;
    } catch (error) {
      return String((error as Error).message);
    }
    throw new Error('the write was accepted');
  };

  it('accepts a design owned by a plan task, or by a card', async () => {
    await ctx.prisma.taskDesign.create({
      data: { planId, taskKey: 't1', needed: true },
    });
    await ctx.prisma.taskDesign.create({ data: { cardId, needed: true } });
    expect(await ctx.prisma.taskDesign.count()).toBe(2);
  });

  it.each([
    ['both owners', () => ({ planId, taskKey: 't1', cardId })],
    ['neither owner', () => ({})],
    ['a plan without a task key', () => ({ planId })],
    ['a task key without a plan', () => ({ taskKey: 't1', cardId })],
  ])('refuses a design with %s', async (_what, owner) => {
    const message = await refused(
      ctx.prisma.taskDesign.create({ data: { ...owner(), needed: true } }),
    );
    expect(message).toContain('task_designs_owner_check');
  });

  it('accepts a turn owned by a plan, or by a card', async () => {
    await ctx.prisma.planTurn.create({
      data: { planId, runId: await runId(), action: 'clarify', input: {} },
    });
    await ctx.prisma.planTurn.create({
      data: { cardId, runId: await runId(), action: 'design', input: {} },
    });
    expect(await ctx.prisma.planTurn.count()).toBe(2);
  });

  it.each([
    ['both owners', () => ({ planId, cardId })],
    ['neither owner', () => ({})],
  ])('refuses a turn with %s', async (_what, owner) => {
    const id = await runId();
    const message = await refused(
      ctx.prisma.planTurn.create({
        data: { ...owner(), runId: id, action: 'design', input: {} },
      }),
    );
    expect(message).toContain('plan_turns_owner_check');
  });

  it('deleting a card takes its design and design turns with it', async () => {
    await ctx.prisma.taskDesign.create({ data: { cardId, needed: true } });
    await ctx.prisma.planTurn.create({
      data: { cardId, runId: await runId(), action: 'design', input: {} },
    });
    await ctx.prisma.boardCard.delete({ where: { id: cardId } });
    expect(await ctx.prisma.taskDesign.count()).toBe(0);
    expect(await ctx.prisma.planTurn.count()).toBe(0);
  });
});
