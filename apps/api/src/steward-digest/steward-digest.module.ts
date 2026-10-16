import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';
import { NotificationsModule } from '../notifications';
import { ProjectsModule } from '../projects';
import { TelegramClient } from '../telegram/telegram-client';
import {
  TELEGRAM_OPTIONS,
  telegramOptionsFromEnv,
} from '../telegram/telegram-options';
import { StewardDigestController } from './steward-digest.controller';
import { StewardDigestService } from './steward-digest.service';
import { StewardDigestComposer } from './steward-digest-composer';
import { StewardDigestTelegram } from './steward-digest-telegram';
import {
  STEWARD_DIGEST_QUEUE,
  StewardDigestWorker,
} from './steward-digest-worker';

/**
 * The Steward digest (#447 D14, ADR-0015): composed daily and when away mode
 * is switched off, stored in `steward_digests`, served at
 * `GET /projects/:id/steward/digest/latest` and sent to Telegram. The
 * `steward-digest` queue is registered only with a `REDIS_URL`.
 *
 * Global, and imported by `AppModule` alone, late in its list (the
 * `TextModule` pattern): `ConditionalModule.registerWhen` starts a 5 s timer
 * when this file is loaded, cleared only once `ConfigModule.forRoot` has run.
 *
 * `TelegramModule` exports no sender, so this module builds its own
 * `TelegramClient` on the public `TELEGRAM_OPTIONS` — the client is stateless
 * and takes the token per call, from `BotTokenStore`.
 */
@Global()
@Module({
  imports: [
    NotificationsModule,
    ProjectsModule,
    ConditionalModule.registerWhen(
      BullModule.registerQueue({ name: STEWARD_DIGEST_QUEUE }),
      (env) => Boolean(env.REDIS_URL?.trim()),
    ),
  ],
  controllers: [StewardDigestController],
  providers: [
    { provide: TELEGRAM_OPTIONS, useFactory: () => telegramOptionsFromEnv() },
    TelegramClient,
    StewardDigestComposer,
    StewardDigestTelegram,
    StewardDigestService,
    StewardDigestWorker,
  ],
  exports: [StewardDigestService],
})
export class StewardDigestModule {}
