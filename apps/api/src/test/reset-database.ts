import { Client } from 'pg';

/** #389: how long `DROP SCHEMA` waits for a lock before the setup gives up. */
export const RESET_LOCK_TIMEOUT_MS = 10_000;

/** PostgreSQL's `lock_not_available`, raised when `lock_timeout` runs out. */
const LOCK_NOT_AVAILABLE = '55P03';

export const withoutParams = (url: URL): string => {
  const copy = new URL(url);
  copy.search = '';
  return copy.toString();
};

export const quoteIdent = (name: string): string =>
  `"${name.replace(/"/g, '""')}"`;

export const databaseName = (url: string | URL): string =>
  new URL(url).pathname.replace(/^\//, '');

/** The maintenance database on the server of `url`. */
export const serverUrl = (url: string | URL): URL => {
  const server = new URL(url);
  server.pathname = '/postgres';
  return server;
};

/**
 * #389: ends every other session on `name` — the connections a killed e2e
 * run left behind, which would otherwise hold `DROP SCHEMA` (and a `TEMPLATE`
 * clone) forever. Returns how many it ended.
 */
export const terminateOtherBackends = async (
  admin: Client,
  name: string,
): Promise<number> => {
  const { rowCount } = await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [name],
  );
  return rowCount ?? 0;
};

/**
 * Creates the database of `url` if it is missing, ends the sessions left on
 * it, then drops and recreates its `public` schema. The drop runs under
 * `lock_timeout`: a lock still held after the sessions are ended fails the
 * setup with a message naming the database, never a hang.
 */
export const resetTestDatabase = async (
  url: URL,
  lockTimeoutMs = RESET_LOCK_TIMEOUT_MS,
): Promise<void> => {
  const name = databaseName(url);
  const admin = new Client({ connectionString: withoutParams(serverUrl(url)) });
  await admin.connect();
  try {
    const { rowCount } = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [name],
    );
    if (rowCount === 0) {
      await admin.query(`CREATE DATABASE ${quoteIdent(name)}`);
    } else {
      await terminateOtherBackends(admin, name);
    }
  } finally {
    await admin.end();
  }

  const db = new Client({ connectionString: withoutParams(url) });
  await db.connect();
  try {
    await db.query(
      `SET lock_timeout = ${Math.max(1, Math.trunc(lockTimeoutMs))}`,
    );
    await db.query('DROP SCHEMA IF EXISTS public CASCADE');
    await db.query('CREATE SCHEMA public');
  } catch (error) {
    if ((error as { code?: string }).code === LOCK_NOT_AVAILABLE) {
      throw new Error(
        `The e2e setup could not reset "${name}": another session still holds a lock on it after ${lockTimeoutMs} ms. ` +
          `Is another e2e run using this database? Each checkout needs a TEST_DATABASE_URL of its own (a board card gets one from AGENTDOCK_CARD).`,
      );
    }
    throw error;
  } finally {
    await db.end();
  }
};
