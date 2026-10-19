import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';
import { LlmModule } from '../llm/llm.module';
import { NotificationsModule } from '../notifications';
import { ProjectsModule } from '../projects';
import { TelegramClient } from '../telegram/telegram-client';
import {
  TELEGRAM_OPTIONS,
  telegramOptionsFromEnv,
} from '../telegram/telegram-options';
import { AiDigestController } from './ai-digest.controller';
import { AiDigestService } from './ai-digest.service';
import { AiDigestComposer } from './ai-digest-composer';
import { AiDigestSettingsService } from './ai-digest-settings.service';
import { AiDigestTelegram } from './ai-digest-telegram';
import { AI_DIGEST_QUEUE, AiDigestWorker } from './ai-digest-worker';

/**
 * The daily AI digest (#658, ADR-0015, ADR-0059): settings and the latest
 * digest under `/projects/:id/ai/digest`, a BullMQ tick that makes the digests
 * that came due, and their Telegram delivery. The `ai-digest` queue is
 * registered only with a `REDIS_URL`.
 *
 * Global, and imported by `AppModule` late in its list, as `StewardDigestModule`
 * is: `ConditionalModule.registerWhen` needs `ConfigModule.forRoot` to have run.
 * `TelegramModule` exports no sender, so this module builds its own stateless
 * `TelegramClient` on the public `TELEGRAM_OPTIONS`.
 */
@Global()
@Module({
  imports: [
    LlmModule,
    NotificationsModule,
    ProjectsModule,
    ConditionalModule.registerWhen(
      BullModule.registerQueue({ name: AI_DIGEST_QUEUE }),
      (env) => Boolean(env.REDIS_URL?.trim()),
    ),
  ],
  controllers: [AiDigestController],
  providers: [
    { provide: TELEGRAM_OPTIONS, useFactory: () => telegramOptionsFromEnv() },
    TelegramClient,
    AiDigestComposer,
    AiDigestSettingsService,
    AiDigestTelegram,
    AiDigestService,
    AiDigestWorker,
  ],
  exports: [AiDigestService],
})
export class AiDigestModule {}
