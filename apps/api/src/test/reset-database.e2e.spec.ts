import { Client } from 'pg';
import {
  databaseName,
  quoteIdent,
  resetTestDatabase,
  serverUrl,
  withoutParams,
} from './reset-database';
import { testDatabaseUrl } from './test-database';

/**
 * #389: a killed e2e run left its connections open, and the next run's
 * `DROP SCHEMA` waited on them forever. Against a scratch database of its own,
 * beside the suite's.
 */
describe('resetTestDatabase (#389)', () => {
  const base = new URL(testDatabaseUrl());
  const url = new URL(base);
  url.pathname = `/${databaseName(base).slice(0, -'_test'.length)}_reset_test`;
  const name = databaseName(url);

  const admin = () =>
    new Client({ connectionString: withoutParams(serverUrl(url)) });

  afterAll(async () => {
    const client = admin();
    await client.connect();
    try {
      await client.query(
        `DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`,
      );
    } finally {
      await client.end();
    }
  });

  it('creates a missing database with an empty public schema', async () => {
    const client = admin();
    await client.connect();
    await client.query(
      `DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`,
    );
    await client.end();

    await resetTestDatabase(url);

    const db = new Client({ connectionString: withoutParams(url) });
    await db.connect();
    try {
      const { rows } = await db.query(
        "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'",
      );
      expect(rows[0].n).toBe(0);
    } finally {
      await db.end();
    }
  });

  it('ends a session left holding a lock in the schema instead of waiting on it', async () => {
    await resetTestDatabase(url);
    const stale = new Client({ connectionString: withoutParams(url) });
    const lost = new Promise<void>((done) => {
      stale.on('error', () => done());
    });
    await stale.connect();
    await stale.query('CREATE TABLE public.left_over (id int)');
    // Idle in a transaction that holds the table: what a killed Jest worker
    // leaves until its socket times out.
    await stale.query('BEGIN');
    await stale.query('LOCK TABLE public.left_over IN ACCESS SHARE MODE');

    const started = Date.now();
    await resetTestDatabase(url, 2_000);
    expect(Date.now() - started).toBeLessThan(2_000);
    await lost;

    const db = new Client({ connectionString: withoutParams(url) });
    await db.connect();
    try {
      const { rows } = await db.query(
        "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'",
      );
      expect(rows[0].n).toBe(0);
    } finally {
      await db.end();
    }
  });
});
