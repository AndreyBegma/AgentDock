import { SYSTEM_ACTOR } from '../audit/audit.types';
import { SecretCipher } from '../common/crypto';
import { BotTokenStore } from '../notifications';
import {
  seedUser,
  TEST_ENCRYPTION_KEY,
} from '../notifications/testing/notifications-e2e';
import { TelegramPoller } from './telegram-poller';
import { BOT_TOKEN, FakeTelegram } from './testing/fake-telegram';
import {
  createTelegramApp,
  resetTelegram,
  type TelegramE2e,
} from './testing/telegram-e2e';

const cipher = () => SecretCipher.fromKeyText(TEST_ENCRYPTION_KEY);

const waitFor = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const polls = (fake: FakeTelegram) =>
  fake.calls.filter((c) => c.method === 'getUpdates').length;

describe('Telegram poller leadership (e2e, D7)', () => {
  const apps: TelegramE2e[] = [];
  const fakes: FakeTelegram[] = [];

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const fake of fakes.splice(0)) await fake.close();
  });

  it('lets exactly one of two instances hold the poller lock', async () => {
    const a = await createTelegramApp(cipher());
    apps.push(a);
    const b = await createTelegramApp(cipher());
    apps.push(b);
    const first = a.app.get(TelegramPoller);
    const second = b.app.get(TelegramPoller);

    expect(await first.acquire()).toBe(true);
    expect(await second.acquire()).toBe(false);
    expect(second.isLeader).toBe(false);
    // Re-entrant for the holder.
    expect(await first.acquire()).toBe(true);

    await first.release();
    expect(await second.acquire()).toBe(true);
    expect(await first.acquire()).toBe(false);
  });

  it('polls Telegram from one instance only when both are started', async () => {
    // Each instance talks to its own fake, so the fakes tell who polled.
    const fakeA = await FakeTelegram.start();
    const fakeB = await FakeTelegram.start();
    fakes.push(fakeA, fakeB);
    const a = await createTelegramApp(cipher(), fakeA, { autoStart: true });
    apps.push(a);
    await resetTelegram(a.prisma);
    const admin = await seedUser(a.prisma, 'root@example.com', 'admin');
    await a.app
      .get(BotTokenStore)
      .set(BOT_TOKEN, 'agentdock_bot', admin.id, { actor: SYSTEM_ACTOR });
    const b = await createTelegramApp(cipher(), fakeB, { autoStart: true });
    apps.push(b);

    await waitFor(() => polls(fakeA) >= 2);
    // B tried the lock when it booted, and lost it.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(polls(fakeB)).toBe(0);
    expect(a.app.get(TelegramPoller).health().polling).toBe(true);
    expect(b.app.get(TelegramPoller).health().polling).toBe(false);
  });
});
