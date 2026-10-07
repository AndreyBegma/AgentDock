import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// `prisma generate` needs no database, so a fresh clone without `.env` can
// still generate the client. Commands that connect fail against the placeholder.
const PLACEHOLDER_URL = 'postgresql://unset:unset@localhost:5432/unset';

export default defineConfig({
  schema: './prisma/schema.prisma',
  migrations: {
    path: './prisma/migrations',
    seed: 'ts-node prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? PLACEHOLDER_URL,
  },
});
