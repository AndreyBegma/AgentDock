import 'dotenv/config';
import { REGISTRATION_SETTING_KEY } from '@agentdock/shared';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { describeConversion, seedPrices } from '../src/prices/seed-prices';

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

  const prices = await seedPrices(prisma);
  if (prices.conversion) {
    console.log('Price version 1 created from the Langfuse snapshot:');
    for (const line of describeConversion(prices.conversion)) {
      console.log(`  ${line}`);
    }
  } else {
    console.log('Prices: a version exists, left unchanged');
  }

  console.log('Seed complete');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
