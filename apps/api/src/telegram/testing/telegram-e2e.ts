import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../app.module';
import { SecretCipher } from '../../common/crypto';
import { configureApp } from '../../configure-app';
import { PrismaService } from '../../database/prisma.service';
import {
  defaultNotificationOptions,
  NOTIFICATION_OPTIONS,
} from '../../notifications/notification-options';
import {
  resetNotifications,
  TEST_ENCRYPTION_KEY,
} from '../../notifications/testing/notifications-e2e';
import type { E2eContext } from '../../test/e2e-app';
import { TELEGRAM_OPTIONS, type TelegramOptions } from '../telegram-options';
import { FakeTelegram } from './fake-telegram';

export interface TelegramE2e extends E2eContext {
  fake: FakeTelegram;
  options: TelegramOptions;
  close: () => Promise<void>;
}

/**
 * The app wired to a `FakeTelegram`: notification timers off, the poller not
 * started (tests call `pollOnce` / `deliverOnce`), `APP_URL` fixed, and
 * `cipher` as the `SecretCipher` (default: `TEST_ENCRYPTION_KEY`).
 */
export const createTelegramApp = async (
  cipher = SecretCipher.fromKeyText(TEST_ENCRYPTION_KEY),
  fake?: FakeTelegram,
  overrides: Partial<TelegramOptions> = {},
): Promise<TelegramE2e> => {
  const telegram = fake ?? (await FakeTelegram.start());
  const options: TelegramOptions = {
    apiBase: telegram.url,
    pollTimeoutS: 1,
    appUrl: 'https://dock.example.com',
    autoStart: false,
    deliveryIntervalMs: 60_000,
    idleMs: 50,
    fetch: (input, init) => fetch(input, init),
    ...overrides,
  };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(NOTIFICATION_OPTIONS)
    .useValue({ ...defaultNotificationOptions, autoStart: false })
    .overrideProvider(SecretCipher)
    .useValue(cipher)
    .overrideProvider(TELEGRAM_OPTIONS)
    .useValue(options)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();
  return {
    app,
    prisma: app.get(PrismaService),
    http: () => request(app.getHttpServer()),
    fake: telegram,
    options,
    close: async () => {
      await app.close();
      if (!fake) await telegram.close();
    },
  };
};

/** Everything a Telegram test touches; links and codes go with their users. */
export const resetTelegram = (prisma: PrismaService) =>
  resetNotifications(prisma);
