import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { PrismaService } from '../database/prisma.service';
import { CreateAdminError, createAdmin } from './create-admin';

/** `bun run admin:create` — interactive, or ADMIN_EMAIL / ADMIN_PASSWORD. */

const ask = async (question: string, hidden = false): Promise<string> => {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const answer = rl.question(question);
  muted = hidden;
  try {
    return await answer;
  } finally {
    rl.close();
    if (hidden) process.stdout.write('\n');
  }
};

const readInput = async () => {
  const envEmail = process.env.ADMIN_EMAIL;
  const envPassword = process.env.ADMIN_PASSWORD;
  if (envEmail && envPassword) {
    return {
      email: envEmail,
      password: envPassword,
      name: process.env.ADMIN_NAME,
    };
  }
  if (!process.stdin.isTTY) {
    throw new CreateAdminError(
      'Set ADMIN_EMAIL and ADMIN_PASSWORD, or run in a terminal',
    );
  }
  const email = envEmail ?? (await ask('Email: '));
  const name = await ask('Name (optional): ');
  const password = envPassword ?? (await ask('Password: ', true));
  if (!envPassword && (await ask('Repeat password: ', true)) !== password) {
    throw new CreateAdminError('Passwords do not match');
  }
  return { email, password, name };
};

async function main() {
  const prisma = new PrismaService();
  try {
    const admin = await createAdmin(prisma, await readInput());
    console.log(`Admin ${admin.email} created`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof CreateAdminError ? error.message : error);
  process.exitCode = 1;
});
