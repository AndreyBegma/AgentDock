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
// #324: never the real DeepL from `.env`; a suite that needs it sets a fake
// key and stubs `fetch` before the app starts.
process.env.DEEPL_API_KEY = '';
// ADR-0059: never the real master key from `.env`; the LLM suites set their own
// before the app starts.
process.env.LLM_SECRETS_KEY = '';
// C-174: the audit chain is keyed in every suite, as it is when deployed; the
// audit suite unsets it to write the unkeyed records of an older chain.
process.env.AUDIT_HMAC_KEY = 'e2e-audit-chain-key-not-a-real-secret-0000';
