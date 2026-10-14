import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// `prisma generate` needs no database, so a fresh clone without `.env` can
// still generate the client. Commands that connect fail against the placeholder.
const PLACEHOLDER_URL = 'postgresql://unset:unset@localhost:5432/unset';

export default defineConfig({
  schema: './prisma/schema.prisma',
  migrations: {
    path: './prisma/migrations',
    // --transpile-only: full type-checking the seed's import graph exhausts the
    // heap of the memory-capped api container at boot.
    seed: 'ts-node --transpile-only prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? PLACEHOLDER_URL,
  },
});
