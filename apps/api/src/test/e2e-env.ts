import { testDatabaseUrl } from './test-database';

// Runs before each e2e file: PrismaService and the app read these at start-up.
process.env.DATABASE_URL = testDatabaseUrl();
process.env.TRUST_PROXY = 'loopback';
process.env.APP_ENV = 'test';
