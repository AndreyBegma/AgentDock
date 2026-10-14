import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { assertRedisReachable } from '../bullmq/bullmq-testing';
import { API_ROOT, testDatabaseUrl, workerDatabaseUrl } from './test-database';
import { testRedisUrl } from './test-redis';

const withoutParams = (url: URL): string => {
  const copy = new URL(url);
  copy.search = '';
  return copy.toString();
};

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

const databaseName = (url: string): string =>
  new URL(url).pathname.replace(/^\//, '');

/**
 * Brings the test database to a clean, fully migrated state: creates it if it
 * is missing, drops the `public` schema, and applies every migration. Not
 * `prisma migrate reset`: Prisma refuses that when an AI agent runs it, which
 * would fail every agent-run `bun run test`.
 *
 * The migrated database is then the template of one database per Jest worker
 * (`workerDatabaseUrl`), recreated on every run, so files in parallel workers
 * never share rows. `--runInBand` makes `maxWorkers` 1: one clone.
 */
export default async function globalSetup(globalConfig: {
  maxWorkers: number;
}): Promise<void> {
  const redisUrl = testRedisUrl();
  try {
    await assertRedisReachable(redisUrl);
  } catch (error) {
    throw new Error(
      `TEST_REDIS_URL is not reachable (${(error as Error).message}) — start it with \`bun run db:setup\`.`,
    );
  }

  const url = new URL(testDatabaseUrl());
  const name = url.pathname.replace(/^\//, '');

  const server = new URL(url);
  server.pathname = '/postgres';
  const admin = new Client({ connectionString: withoutParams(server) });
  await admin.connect();
  try {
    const { rowCount } = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [name],
    );
    if (rowCount === 0) {
      await admin.query(`CREATE DATABASE ${quoteIdent(name)}`);
    }
  } finally {
    await admin.end();
  }

  const db = new Client({ connectionString: withoutParams(url) });
  await db.connect();
  try {
    await db.query('DROP SCHEMA IF EXISTS public CASCADE');
    await db.query('CREATE SCHEMA public');
  } finally {
    await db.end();
  }

  execFileSync(
    process.execPath,
    [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
    {
      cwd: API_ROOT,
      env: { ...process.env, DATABASE_URL: url.toString() },
      stdio: 'pipe',
    },
  );

  // CREATE DATABASE … TEMPLATE needs the template free of connections: every
  // client above is closed and `migrate deploy` has exited.
  const cloner = new Client({ connectionString: withoutParams(server) });
  await cloner.connect();
  try {
    for (let id = 1; id <= Math.max(1, globalConfig.maxWorkers); id += 1) {
      const worker = quoteIdent(databaseName(workerDatabaseUrl(id)));
      await cloner.query(`DROP DATABASE IF EXISTS ${worker} WITH (FORCE)`);
      await cloner.query(
        `CREATE DATABASE ${worker} TEMPLATE ${quoteIdent(name)}`,
      );
    }
  } finally {
    await cloner.end();
  }
}
