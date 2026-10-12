import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications';
import { SettingsModule } from '../settings/settings.module';
import {
  TelegramAdminController,
  TelegramLinkController,
} from './telegram.controller';
import { TelegramClient } from './telegram-client';
import { TelegramDeliveryService } from './telegram-delivery.service';
import { TelegramIntegrationService } from './telegram-integration.service';
import { TelegramLinkingService } from './telegram-linking.service';
import { TELEGRAM_OPTIONS, telegramOptionsFromEnv } from './telegram-options';
import { TelegramPoller } from './telegram-poller';

/**
 * The Telegram bot (spec 22 D7–D10): the Bot API client, the one long-polling
 * leader, account linking, and delivery of what `NotificationsModule`'s ledger
 * hands out. D12's inline buttons are not here (spec 22 notes).
 */
@Module({
  imports: [NotificationsModule, SettingsModule],
  controllers: [TelegramLinkController, TelegramAdminController],
  providers: [
    { provide: TELEGRAM_OPTIONS, useFactory: () => telegramOptionsFromEnv() },
    TelegramClient,
    TelegramLinkingService,
    TelegramDeliveryService,
    TelegramPoller,
    TelegramIntegrationService,
  ],
  exports: [TelegramPoller, TelegramDeliveryService],
})
export class TelegramModule {}
