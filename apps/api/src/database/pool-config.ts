import type { PoolConfig } from 'pg';

/**
 * #487: Prisma's own pool parameters. The pg driver adapter ignores them, so
 * `pgPoolConfig` reads them into the `pg.Pool` it builds instead.
 */
export const CONNECTION_LIMIT_PARAM = 'connection_limit';
export const POOL_TIMEOUT_PARAM = 'pool_timeout';

const positiveInt = (value: string | null, param: string): number | null => {
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `The database URL's ${param} is "${value}"; it must be a whole number of at least 1.`,
    );
  }
  return n;
};

/** `url` without Prisma's pool parameters; every other parameter kept. */
export const withoutPoolParams = (url: string): string => {
  const copy = new URL(url);
  copy.searchParams.delete(CONNECTION_LIMIT_PARAM);
  copy.searchParams.delete(POOL_TIMEOUT_PARAM);
  return copy.toString();
};

/**
 * #487: the `pg.Pool` config of a database URL. `connection_limit` bounds the
 * pool (`max`); `pool_timeout`, in seconds as in Prisma, bounds the wait for
 * a connection (`connectionTimeoutMillis`), so a full server fails a query
 * fast instead of hanging. Without them, pg's defaults hold.
 */
export const pgPoolConfig = (url: string | undefined): PoolConfig => {
  if (!url) return { connectionString: url };
  const params = new URL(url).searchParams;
  const max = positiveInt(
    params.get(CONNECTION_LIMIT_PARAM),
    CONNECTION_LIMIT_PARAM,
  );
  const timeout = positiveInt(
    params.get(POOL_TIMEOUT_PARAM),
    POOL_TIMEOUT_PARAM,
  );
  return {
    connectionString: withoutPoolParams(url),
    ...(max === null ? {} : { max }),
    ...(timeout === null ? {} : { connectionTimeoutMillis: timeout * 1000 }),
  };
};
