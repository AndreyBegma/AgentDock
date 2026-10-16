import { Client } from 'pg';
import { pgPoolConfig } from '../database/pool-config';

/** #487: how long the e2e setup waits to connect before it gives up. */
export const SETUP_CONNECT_TIMEOUT_MS = 10_000;

/** PostgreSQL's `too_many_connections`: "sorry, too many clients already". */
const TOO_MANY_CONNECTIONS = '53300';

/** pg's own pool size when a URL sets no `connection_limit`. */
const PG_DEFAULT_POOL_MAX = 10;

const ADVICE =
  'Another e2e run is probably using the server — run only the suites you touched (`--testPathPatterns`), or wait for it to finish.';

export interface ConnectionStats {
  maxConnections: number;
  /** Slots only a superuser may take. */
  reserved: number;
  inUse: number;
}

/**
 * #487: the connections an e2e run opens at most — one Prisma pool per Jest
 * worker, each of `connection_limit` (pg's default without it), plus one for
 * the setup itself.
 */
export const connectionsNeeded = (
  workerUrl: string,
  maxWorkers: number,
): number =>
  Math.max(1, maxWorkers) *
    (pgPoolConfig(workerUrl).max ?? PG_DEFAULT_POOL_MAX) +
  1;

/**
 * #487: why the server cannot take the run, or null when it can. Three card
 * workers' e2e runs at once filled the dev server; each suite then failed
 * after minutes of timeouts with errors that named something else.
 */
export const connectionShortage = (
  stats: ConnectionStats,
  needed: number,
): string | null => {
  const free = stats.maxConnections - stats.reserved - stats.inUse;
  if (free >= needed) return null;
  return (
    `The e2e run needs up to ${needed} database connections, and the server has ${Math.max(0, free)} free ` +
    `(max_connections ${stats.maxConnections}, ${stats.reserved} reserved, ${stats.inUse} in use). ${ADVICE}`
  );
};

/**
 * #487: a connected client on `connectionString`, or an error that says the
 * server is full — never a hang: the connect gives up after
 * `SETUP_CONNECT_TIMEOUT_MS`.
 */
export const connectOrExplain = async (
  connectionString: string,
): Promise<Client> => {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: SETUP_CONNECT_TIMEOUT_MS,
  });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.end().catch(() => undefined);
    const host = new URL(connectionString).host;
    if ((error as { code?: string }).code === TOO_MANY_CONNECTIONS) {
      throw new Error(
        `The e2e setup could not connect to ${host}: it has no free connections ("too many clients already"). ${ADVICE}`,
      );
    }
    throw new Error(
      `The e2e setup could not connect to ${host}: ${(error as Error).message}. Is it running (\`bun run db:setup\`), and does it have free connections? ${ADVICE}`,
    );
  }
};

/** #487: the server's connection limits and how many client sessions hold slots. */
export const readConnectionStats = async (
  admin: Client,
): Promise<ConnectionStats> => {
  const { rows } = await admin.query<{
    max: number;
    reserved: number;
    in_use: number;
  }>(
    `SELECT current_setting('max_connections')::int AS max,
            current_setting('superuser_reserved_connections')::int AS reserved,
            (SELECT count(*)::int FROM pg_stat_activity
              WHERE backend_type = 'client backend') AS in_use`,
  );
  const [row] = rows;
  return { maxConnections: row.max, reserved: row.reserved, inUse: row.in_use };
};
