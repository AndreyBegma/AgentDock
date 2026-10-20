import { resolve } from 'node:path';
import { config } from 'dotenv';
import {
  CONNECTION_LIMIT_PARAM,
  POOL_TIMEOUT_PARAM,
} from '../database/pool-config';

export const API_ROOT = resolve(__dirname, '../..');

/** #389: what the runner sets in a board card's session — its short id. */
const CARD_ID = /^[a-z0-9]{8}$/;

/**
 * #487: the Prisma pool of one Jest worker of a board card. Card workers run
 * their e2e suites on one dev server at once; 5 per pool keeps a card at 10
 * (`--maxWorkers=2`), so several cards stay under `max_connections`.
 */
export const CARD_CONNECTION_LIMIT = 5;

/** #487: seconds a card's query waits for a pooled connection before it fails. */
export const CARD_POOL_TIMEOUT_S = 10;

/**
 * #389: a board card's own test database — `agentdock_test` →
 * `agentdock_card_<shortId>_test` on the same server — so card worktrees that
 * copied one `.env` never share, and never wipe, each other's database.
 * #487: and a bounded pool — `connection_limit` and `pool_timeout`, unless the
 * URL sets its own. Without a card the URL is `url` unchanged.
 */
export const cardTestDatabaseUrl = (
  url: string,
  card: string | undefined,
): string => {
  if (!card) return url;
  if (!CARD_ID.test(card)) {
    throw new Error(
      `NAUTELLE_CARD is "${card}"; a board card's short id is 8 characters of a-z and 0-9.`,
    );
  }
  const copy = new URL(url);
  const name = copy.pathname.replace(/^\//, '');
  copy.pathname = `/${name.slice(0, -'_test'.length)}_card_${card}_test`;
  const params = copy.searchParams;
  if (!params.has(CONNECTION_LIMIT_PARAM)) {
    params.set(CONNECTION_LIMIT_PARAM, String(CARD_CONNECTION_LIMIT));
  }
  if (!params.has(POOL_TIMEOUT_PARAM)) {
    params.set(POOL_TIMEOUT_PARAM, String(CARD_POOL_TIMEOUT_S));
  }
  return copy.toString();
};

/**
 * The database the e2e suite owns and wipes. Required: without it the suite
 * fails rather than silently skipping. The `_test` suffix is a guard against
 * pointing it at a database someone works in. In a board card's session
 * (`NAUTELLE_CARD`, #389; `AGENTDOCK_CARD` until runner 0.16.0, ADR-0073) it
 * is the card's own, named after it.
 */
export const testDatabaseUrl = (): string => {
  config({ path: resolve(API_ROOT, '.env'), quiet: true });
  const value = process.env.TEST_DATABASE_URL;
  if (!value) {
    throw new Error(
      'TEST_DATABASE_URL is not set — the e2e tests need a PostgreSQL database ' +
        'they may wipe. See apps/api/.env.example.',
    );
  }
  const name = new URL(value).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(
      `TEST_DATABASE_URL points at "${name}"; its name must end in _test, because the e2e suite wipes it.`,
    );
  }
  return cardTestDatabaseUrl(
    value,
    process.env.NAUTELLE_CARD ?? process.env.AGENTDOCK_CARD,
  );
};

/**
 * The database of one Jest worker: `agentdock_test` → `agentdock_2_test`, on
 * the same server. `globalSetup` clones it from the migrated test database, so
 * workers running in parallel never see each other's rows.
 */
export const workerDatabaseUrl = (workerId: string | number): string => {
  const url = new URL(testDatabaseUrl());
  const name = url.pathname.replace(/^\//, '');
  url.pathname = `/${name.slice(0, -'_test'.length)}_${workerId}_test`;
  return url.toString();
};
