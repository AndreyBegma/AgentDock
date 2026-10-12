import { resolve } from 'node:path';
import { config } from 'dotenv';
import { API_ROOT } from './test-database';

/**
 * The Redis the e2e suite uses. Required, like the database: without it the
 * suite fails rather than silently skipping. Each run keeps to its own key
 * prefix (`testQueuePrefix()`), so nothing outside it is touched.
 */
export const testRedisUrl = (): string => {
  config({ path: resolve(API_ROOT, '.env'), quiet: true });
  const value = process.env.TEST_REDIS_URL;
  if (!value) {
    throw new Error(
      'TEST_REDIS_URL is not set — the e2e tests need a Redis for BullMQ. ' +
        'See apps/api/.env.example.',
    );
  }
  return value;
};
