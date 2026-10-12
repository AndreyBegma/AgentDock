import { testQueuePrefix } from '../bullmq/bullmq-testing';
import { testDatabaseUrl } from './test-database';
import { testRedisUrl } from './test-redis';

// Runs before each e2e file: PrismaService and the app read these at start-up.
process.env.DATABASE_URL = testDatabaseUrl();
process.env.REDIS_URL = testRedisUrl();
process.env.QUEUE_PREFIX = testQueuePrefix();
process.env.TRUST_PROXY = 'loopback';
process.env.APP_ENV = 'test';
