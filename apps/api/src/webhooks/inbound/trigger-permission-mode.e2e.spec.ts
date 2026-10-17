import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { createUser, type E2eContext } from '../../test/e2e-app';
import { withoutParams } from '../../test/reset-database';
import { API_ROOT } from '../../test/test-database';
import {
  createInboundApp,
  resetInbound,
  seedSkillProject,
} from './testing/inbound-e2e';

const MIGRATION = join(
  API_ROOT,
  'prisma/migrations/20261220000000_trigger_permission_mode/migration.sql',
);

const legacySkill = {
  kind: 'skill',
  skill: 'estimate',
  args: 'branch {{payload.ref}}',
  output: 'report',
};

/** C-132: the migration gives every stored skill action an explicit, non-bypass mode. */
describe('trigger_permission_mode (C-132)', () => {
  let ctx: E2eContext;

  beforeAll(async () => {
    ctx = await createInboundApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(() => resetInbound(ctx.prisma));

  /** The migration as Prisma runs it: one multi-statement script. */
  const migrate = async () => {
    const client = new Client({
      connectionString: withoutParams(new URL(process.env.DATABASE_URL ?? '')),
    });
    await client.connect();
    try {
      await client.query(readFileSync(MIGRATION, 'utf8'));
    } finally {
      await client.end();
    }
  };

  it('backfills `manual` into skill actions, leaves the rest, and is idempotent', async () => {
    const { projectId } = await seedSkillProject(ctx.prisma);
    const admin = await createUser(ctx.prisma, 'admin@example.com', 'admin');
    let n = 0;
    const seed = (action: object) => {
      n += 1;
      return ctx.prisma.inboundTrigger.create({
        data: {
          publicId: `p${String(n).padStart(23, '0')}`,
          name: `t${n}`,
          projectId,
          action,
          allowedPaths: ['ref'],
          secret: 'sealed',
          bucketTokens: 30,
          bucketRefilledAt: new Date(),
          createdById: admin.id,
        },
      });
    };
    const legacy = await seed(legacySkill);
    const explicit = await seed({ ...legacySkill, permissionMode: 'auto' });
    const orchestrator = await seed({ kind: 'orchestrator', mode: 'next' });

    await migrate();
    await migrate();

    const action = async (id: string) =>
      (await ctx.prisma.inboundTrigger.findUniqueOrThrow({ where: { id } }))
        .action;
    expect(await action(legacy.id)).toEqual({
      ...legacySkill,
      permissionMode: 'manual',
    });
    expect(await action(explicit.id)).toEqual({
      ...legacySkill,
      permissionMode: 'auto',
    });
    expect(await action(orchestrator.id)).toEqual({
      kind: 'orchestrator',
      mode: 'next',
    });
  });
});
