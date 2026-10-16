import { resolve } from 'node:path';
import { config } from 'dotenv';

export const API_ROOT = resolve(__dirname, '../..');

/** #389: what the runner sets in a board card's session — its short id. */
const CARD_ID = /^[a-z0-9]{8}$/;

/**
 * #389: a board card's own test database — `agentdock_test` →
 * `agentdock_card_<shortId>_test` on the same server — so card worktrees that
 * copied one `.env` never share, and never wipe, each other's database.
 * Without a card the URL is `url` unchanged.
 */
export const cardTestDatabaseUrl = (
  url: string,
  card: string | undefined,
): string => {
  if (!card) return url;
  if (!CARD_ID.test(card)) {
    throw new Error(
      `AGENTDOCK_CARD is "${card}"; a board card's short id is 8 characters of a-z and 0-9.`,
    );
  }
  const copy = new URL(url);
  const name = copy.pathname.replace(/^\//, '');
  copy.pathname = `/${name.slice(0, -'_test'.length)}_card_${card}_test`;
  return copy.toString();
};

/**
 * The database the e2e suite owns and wipes. Required: without it the suite
 * fails rather than silently skipping. The `_test` suffix is a guard against
 * pointing it at a database someone works in. In a board card's session
 * (`AGENTDOCK_CARD`, #389) it is the card's own, named after it.
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
  return cardTestDatabaseUrl(value, process.env.AGENTDOCK_CARD);
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
