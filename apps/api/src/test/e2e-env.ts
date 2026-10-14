import { testQueuePrefix } from '../bullmq/bullmq-testing';
import { workerDatabaseUrl } from './test-database';
import { testRedisUrl } from './test-redis';

// Runs before each e2e file: PrismaService and the app read these at start-up.
// Each Jest worker has a database of its own (global-setup.ts); the queue
// prefix is per process, so per worker too.
process.env.DATABASE_URL = workerDatabaseUrl(process.env.JEST_WORKER_ID ?? 1);
process.env.REDIS_URL = testRedisUrl();
process.env.QUEUE_PREFIX = testQueuePrefix();
process.env.TRUST_PROXY = 'loopback';
process.env.APP_ENV = 'test';
