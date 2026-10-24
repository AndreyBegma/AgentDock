import 'dotenv/config';
import { Client } from 'pg';
import { PrismaService } from '../database/prisma.service';
import {
  DemoDataError,
  demoDatabaseUrl,
  maintenanceUrl,
  seedDemo,
} from './demo-data';

/**
 * `bun run demo:db <command> <name>` — the demo database of
 * `scripts/demo-dev.sh` (C-383), on the server of DATABASE_URL:
 *
 * - `url`: prints its URL, for the script to hand to Prisma and the API;
 * - `create`: drops whatever a previous recording left and creates it empty;
 * - `seed`: adds the demo project and cards for DEMO_LOGIN_EMAIL;
 * - `drop`: drops it.
 */

const withServer = async <T>(
  url: string,
  run: (client: Client) => Promise<T>,
): Promise<T> => {
  const client = new Client({ connectionString: maintenanceUrl(url) });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
};

/** Ends the API's sessions on `name` and drops it; a missing one is fine. */
const drop = (url: string, name: string) =>
  withServer(url, async (client) => {
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name],
    );
    await client.query(`DROP DATABASE IF EXISTS "${name}"`);
  });

async function main() {
  const [command, name = ''] = process.argv.slice(2);
  const base = process.env.DATABASE_URL;
  if (!base) throw new DemoDataError('DATABASE_URL is not set');
  const url = demoDatabaseUrl(base, name);

  switch (command) {
    case 'url':
      process.stdout.write(url);
      return;
    case 'create':
      await drop(url, name);
      // `name` passed demoDatabaseUrl's check: letters, digits and _ only.
      await withServer(url, (client) =>
        client.query(`CREATE DATABASE "${name}"`),
      );
      console.log(`Demo database ${name} created`);
      return;
    case 'seed': {
      const email = process.env.DEMO_LOGIN_EMAIL;
      if (!email) throw new DemoDataError('DEMO_LOGIN_EMAIL is not set');
      process.env.DATABASE_URL = url;
      const prisma = new PrismaService();
      try {
        const seeded = await seedDemo(prisma, email);
        console.log(
          `Demo project ${seeded.projectId} with ${seeded.cards} cards ready`,
        );
      } finally {
        await prisma.$disconnect();
      }
      return;
    }
    case 'drop':
      await drop(url, name);
      console.log(`Demo database ${name} dropped`);
      return;
    default:
      throw new DemoDataError(
        'Usage: demo:db url|create|seed|drop agentdock_demo[_<id>]',
      );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof DemoDataError ? error.message : error);
  process.exitCode = 1;
});
