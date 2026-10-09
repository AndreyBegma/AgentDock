import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { API_ROOT, testDatabaseUrl } from './test-database';

const withoutParams = (url: URL): string => {
  const copy = new URL(url);
  copy.search = '';
  return copy.toString();
};

/**
 * Brings the test database to a clean, fully migrated state: creates it if it
 * is missing, drops the `public` schema, and applies every migration. Not
 * `prisma migrate reset`: Prisma refuses that when an AI agent runs it, which
 * would fail every agent-run `bun run test`.
 */
export default async function globalSetup(): Promise<void> {
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
      await admin.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
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
}
