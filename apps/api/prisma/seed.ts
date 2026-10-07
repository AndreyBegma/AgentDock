import 'dotenv/config';
import { REGISTRATION_SETTING_KEY } from '@agentdock/shared';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

// The seed creates no users: the first admin comes from `bun run admin:create`.
async function main() {
  await prisma.setting.upsert({
    where: { key: REGISTRATION_SETTING_KEY },
    update: {},
    create: { key: REGISTRATION_SETTING_KEY, value: false },
  });

  console.log('Seed complete');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
