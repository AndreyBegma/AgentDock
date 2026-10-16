import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { assertRedisReachable } from '../bullmq/bullmq-testing';
import {
  databaseName,
  quoteIdent,
  resetTestDatabase,
  serverUrl,
  terminateOtherBackends,
  withoutParams,
} from './reset-database';
import { API_ROOT, testDatabaseUrl, workerDatabaseUrl } from './test-database';
import { testRedisUrl } from './test-redis';

/**
 * Brings the test database to a clean, fully migrated state: creates it if it
 * is missing, ends the sessions a killed run left on it, drops the `public`
 * schema, and applies every migration. Not `prisma migrate reset`: Prisma
 * refuses that when an AI agent runs it, which would fail every agent-run
 * `bun run test`.
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
  const name = databaseName(url);
  await resetTestDatabase(url);

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
  // client above is closed and `migrate deploy` has exited; anything else
  // still on it is ended first.
  const cloner = new Client({
    connectionString: withoutParams(serverUrl(url)),
  });
  await cloner.connect();
  try {
    await terminateOtherBackends(cloner, name);
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
