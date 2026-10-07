import { resolve } from 'node:path';
import { config } from 'dotenv';

export const API_ROOT = resolve(__dirname, '../..');

/**
 * The database the e2e suite owns and wipes. Required: without it the suite
 * fails rather than silently skipping. The `_test` suffix is a guard against
 * pointing it at a database someone works in.
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
  return value;
};
