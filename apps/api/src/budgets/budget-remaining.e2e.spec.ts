import { localBudgetRemainingResultSchema } from '@agentdock/shared/protocol';
import { Logger } from '@nestjs/common';
import { seedProject } from '../fleet/testing/fleet-e2e';
import { seedPrices } from '../prices/seed-prices';
import {
  createE2eApp,
  createUser,
  type E2eContext,
  login,
  resetDatabase,
  type Session,
} from '../test/e2e-app';
import { ingest, resetUsage } from '../usage/testing/usage-e2e';
import { BudgetClock } from './budget-options';
import { BudgetsService } from './budgets.service';
import { Feed } from './testing/budgets-e2e';

const ROOT = '/srv/dev/widget';
/** A Friday morning, UTC. */
const NOW = Date.parse('2026-10-09T10:00:00.000Z');
const at = (s: number) => new Date(NOW + s * 1000).toISOString();

/**
 * Spec 201 D15, acceptance criterion 12: `BudgetsService.remaining` lists the
 * enabled budgets of a project and a user with `remaining = limit − spent`,
 * and a user budget counts the manual sessions that user owns.
 */
describe('remaining budget (e2e)', () => {
  let ctx: E2eContext;
  let budgets: BudgetsService;
  let admin: Session;
  let runnerId: string;
  let projectId: string;
  let ownerId: string;
  let otherId: string;
  let feed: Feed;

  const createBudget = async (body: object) => {
    const response = await admin.send('post', '/admin/budgets', {
      period: 'day',
      limitUsd: '10',
      action: 'alert',
      timezone: 'UTC',
      ...body,
    });
    expect(response.status).toBe(201);
  };

  beforeAll(async () => {
    ctx = await createE2eApp();
    budgets = ctx.app.get(BudgetsService);
    ctx.app.get(BudgetClock).set(new Date(NOW));
  });
  afterAll(() => ctx.app.close());

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await resetUsage(ctx.prisma);
    await seedPrices(ctx.prisma);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    ({ runnerId, projectId } = await seedProject(ctx.prisma, ROOT));
    await createUser(ctx.prisma, 'admin@example.com', 'admin');
    admin = await login(ctx, 'admin@example.com');
    ownerId = (await createUser(ctx.prisma, 'owner@example.com', 'operator'))
      .id;
    otherId = (await createUser(ctx.prisma, 'other@example.com', 'operator'))
      .id;
    feed = new Feed();
  });

  it('counts the manual sessions a user owns toward their budget', async () => {
    // A session in a subdirectory, with no slot and no run: by the earlier
    // rules nobody's. Hooks set its owner (D14).
    await ingest(ctx, runnerId, [
      feed.session('manual-1', `${ROOT}/apps/api`, at(-60), { projectId }),
      feed.spend('manual-1', 'r-1', at(-30)),
      feed.spend('manual-1', 'r-2', at(-20)),
    ]);
    await ctx.prisma.agentSession.updateMany({
      where: { externalId: 'manual-1' },
      data: { origin: 'manual', ownerId },
    });
    await createBudget({ scope: 'project', projectId, limitUsd: '20' });
    await createBudget({ scope: 'user', userId: ownerId, action: 'stop' });
    await createBudget({ scope: 'user', userId: otherId });

    const mine = await budgets.remaining({ projectId, userId: ownerId });
    expect(
      localBudgetRemainingResultSchema.safeParse({ budgets: mine }).success,
    ).toBe(true);
    expect(
      mine.map((b) => [
        b.scope,
        b.action,
        b.limitUsd,
        b.spentUsd,
        b.remainingUsd,
      ]),
    ).toEqual([
      ['project', 'alert', '20.000000', '3.000000', '17.000000'],
      ['user', 'stop', '10.000000', '3.000000', '7.000000'],
    ]);
    expect(mine[0].resetsAt).toBe('2026-10-10T00:00:00.000Z');

    const theirs = await budgets.remaining({ projectId, userId: otherId });
    expect(theirs.map((b) => [b.scope, b.spentUsd])).toEqual([
      ['project', '3.000000'],
      ['user', '0.000000'],
    ]);
  });

  it('goes negative past the limit, and leaves disabled budgets out', async () => {
    await ingest(ctx, runnerId, [
      feed.session('manual-1', `${ROOT}/x`, at(-60), { projectId }),
      ...Array.from({ length: 8 }, (_, i) =>
        feed.spend('manual-1', `r-${i}`, at(-50 + i)),
      ),
    ]);
    await ctx.prisma.agentSession.updateMany({
      where: { externalId: 'manual-1' },
      data: { ownerId },
    });
    await createBudget({ scope: 'user', userId: ownerId });
    await createBudget({ scope: 'project', projectId, enabled: false });

    const result = await budgets.remaining({ projectId, userId: ownerId });
    expect(result.map((b) => [b.scope, b.remainingUsd])).toEqual([
      ['user', '-2.000000'],
    ]);
  });
});
