import { execFileSync } from 'node:child_process';
import { assertRedisReachable } from '../bullmq/bullmq-testing';
import { withoutPoolParams } from '../database/pool-config';
import {
  connectionShortage,
  connectionsNeeded,
  connectOrExplain,
  readConnectionStats,
} from './connection-budget';
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
 *
 * #487: first, the server must have room for every worker's pool; a full
 * server fails the run at once, with a message that says so.
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
  const admin = await connectOrExplain(withoutParams(serverUrl(url)));
  try {
    const shortage = connectionShortage(
      await readConnectionStats(admin),
      connectionsNeeded(workerDatabaseUrl(1), globalConfig.maxWorkers),
    );
    if (shortage) throw new Error(shortage);
  } finally {
    await admin.end();
  }
  await resetTestDatabase(url);

  execFileSync(
    process.execPath,
    [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
    {
      cwd: API_ROOT,
      env: { ...process.env, DATABASE_URL: withoutPoolParams(url.toString()) },
      stdio: 'pipe',
    },
  );

  // CREATE DATABASE … TEMPLATE needs the template free of connections: every
  // client above is closed and `migrate deploy` has exited; anything else
  // still on it is ended first.
  const cloner = await connectOrExplain(withoutParams(serverUrl(url)));
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
