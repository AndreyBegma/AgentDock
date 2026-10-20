import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROFILE_ENV_VALUE_NAMES } from '@nautelle/shared/protocol';
import { Client } from 'pg';
import { createE2eApp, type E2eContext } from '../test/e2e-app';
import { withoutParams } from '../test/reset-database';
import { API_ROOT } from '../test/test-database';
import { toAdminCapabilities, toAdminProfile } from './runner-mapper';

const MIGRATION = join(
  API_ROOT,
  'prisma/migrations/20261219000000_scrub_profile_env_values/migration.sql',
);

const SECRET = 'sk-ant-x';

/** A stored profile env as a runner sent it before C-123: names to values. */
const leakedEnv = {
  ANTHROPIC_API_KEY: SECRET,
  CLAUDE_CONFIG_DIR: '/home/dev/.claude-profiles/work',
  CODEX_HOME: '/home/dev/.codex',
  PATH: '/usr/bin',
};

const scrubbedEnv = {
  ANTHROPIC_API_KEY: { set: true },
  CLAUDE_CONFIG_DIR: '/home/dev/.claude-profiles/work',
  CODEX_HOME: '/home/dev/.codex',
  PATH: { set: true },
};

/** No value outside the allowlist: every other entry is `{ set: true }`. */
const namesOnly = (env: unknown): boolean =>
  typeof env === 'object' &&
  env !== null &&
  Object.entries(env).every(([name, value]) =>
    PROFILE_ENV_VALUE_NAMES.includes(name)
      ? typeof value === 'string'
      : JSON.stringify(value) === '{"set":true}',
  );

/** C-123: the migration strips stored env values; the admin mappers never show one. */
describe('scrub_profile_env_values (C-123)', () => {
  let ctx: E2eContext;

  beforeAll(async () => {
    ctx = await createE2eApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await ctx.prisma.$executeRawUnsafe('TRUNCATE TABLE runners CASCADE');
  });

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

  const seed = async () => {
    const runner = await ctx.prisma.runner.create({
      data: {
        name: 'laptop',
        capabilities: {
          tmux: '3.5a',
          profiles: [
            { id: 'claude-work', runtime: 'claude', env: leakedEnv, args: [] },
            { id: 'codex', runtime: 'codex', env: 'not an object', args: [] },
            { id: 'bare', runtime: 'claude', args: [] },
          ],
        },
      },
    });
    const profile = await ctx.prisma.runtimeProfile.create({
      data: {
        runnerId: runner.id,
        key: 'claude-work',
        runtime: 'claude',
        label: 'claude-work',
        env: leakedEnv,
        args: [],
        authenticated: true,
      },
    });
    return { runner, profile };
  };

  it('leaves no stored env value outside the allowlist, and is idempotent', async () => {
    const { runner, profile } = await seed();
    await ctx.prisma.runner.create({ data: { name: 'never said hello' } });

    await migrate();

    const row = await ctx.prisma.runtimeProfile.findUniqueOrThrow({
      where: { id: profile.id },
    });
    expect(row.env).toEqual(scrubbedEnv);
    const stored = await ctx.prisma.runner.findUniqueOrThrow({
      where: { id: runner.id },
    });
    expect(stored.capabilities).toEqual({
      tmux: '3.5a',
      profiles: [
        { id: 'claude-work', runtime: 'claude', env: scrubbedEnv, args: [] },
        { id: 'codex', runtime: 'codex', env: {}, args: [] },
        { id: 'bare', runtime: 'claude', args: [] },
      ],
    });

    await migrate();
    const runners = await ctx.prisma.runner.findMany();
    const profiles = await ctx.prisma.runtimeProfile.findMany();
    expect(profiles.every((p) => namesOnly(p.env))).toBe(true);
    for (const r of runners) {
      const caps = r.capabilities as { profiles?: { env?: unknown }[] } | null;
      for (const p of caps?.profiles ?? []) {
        if (p.env !== undefined) expect(namesOnly(p.env)).toBe(true);
      }
    }
    const storedJson = JSON.stringify({
      capabilities: runners.map((r) => r.capabilities),
      env: profiles.map((p) => p.env),
    });
    expect(storedJson).not.toContain(SECRET);
  });

  it('never shows a value from a row the migration did not see', async () => {
    const { runner, profile } = await seed();
    const row = await ctx.prisma.runtimeProfile.findUniqueOrThrow({
      where: { id: profile.id },
    });
    expect(toAdminProfile(row).env).toEqual(scrubbedEnv);
    const stored = await ctx.prisma.runner.findUniqueOrThrow({
      where: { id: runner.id },
    });
    const shown = toAdminCapabilities(stored.capabilities);
    expect(JSON.stringify(shown)).not.toContain(SECRET);
    expect(shown?.profiles[0]?.env).toEqual(scrubbedEnv);
    expect(toAdminCapabilities(null)).toBeNull();
  });
});
