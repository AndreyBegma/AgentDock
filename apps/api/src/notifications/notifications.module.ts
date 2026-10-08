import { Module } from '@nestjs/common';
import { CryptoModule } from '../common/crypto';
import { LiveModule } from '../live/live.module';
import { ProjectsModule } from '../projects';
import { RunnersModule } from '../runners/runners.module';
import { SettingsModule } from '../settings/settings.module';
import { BotTokenStore } from './bot-token.store';
import { NotificationMatcher } from './notification-matcher';
import {
  defaultNotificationOptions,
  NOTIFICATION_OPTIONS,
} from './notification-options';
import { NotificationRulesService } from './notification-rules.service';
import { NotificationWriter } from './notification-writer';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { RunnerWatcher } from './runner-watcher';
import { TelegramDeliveryLedger } from './telegram-delivery-ledger';

/**
 * Notifications (docs/specs/22): the event matcher, the runner watcher, the
 * in-app centre with its rules and mutes, and the bookkeeping the Telegram
 * module sends from. Exports what `apps/api/src/telegram/**` builds on.
 */
@Module({
  imports: [
    CryptoModule,
    LiveModule,
    ProjectsModule,
    RunnersModule,
    SettingsModule,
  ],
  controllers: [NotificationsController],
  providers: [
    {
      provide: NOTIFICATION_OPTIONS,
      // The e2e suite drives `tick()` itself; timers would race its fixtures.
      useFactory: () => ({
        ...defaultNotificationOptions,
        autoStart: process.env.APP_ENV !== 'test',
      }),
    },
    NotificationWriter,
    NotificationsService,
    NotificationRulesService,
    NotificationMatcher,
    RunnerWatcher,
    TelegramDeliveryLedger,
    BotTokenStore,
  ],
  exports: [
    CryptoModule,
    BotTokenStore,
    TelegramDeliveryLedger,
    NotificationsService,
    NotificationRulesService,
  ],
})
export class NotificationsModule {}
