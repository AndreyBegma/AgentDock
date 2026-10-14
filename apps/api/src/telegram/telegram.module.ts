import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals';
import { LocalModule } from '../local';
import { NotificationsModule } from '../notifications';
import { ProjectsModule } from '../projects';
import { SettingsModule } from '../settings/settings.module';
import {
  TelegramAdminController,
  TelegramLinkController,
} from './telegram.controller';
import { TelegramActionRequestService } from './telegram-action-request.service';
import { TelegramApprovalService } from './telegram-approval.service';
import { TelegramClient } from './telegram-client';
import { TelegramDeliveryService } from './telegram-delivery.service';
import { TelegramIntegrationService } from './telegram-integration.service';
import { TelegramLinkingService } from './telegram-linking.service';
import { TELEGRAM_OPTIONS, telegramOptionsFromEnv } from './telegram-options';
import { TelegramPoller } from './telegram-poller';

/**
 * The Telegram bot (spec 22 D7–D10): the Bot API client, the one long-polling
 * leader, account linking, and delivery of what `NotificationsModule`'s ledger
 * hands out, with D12's Approve / Request changes buttons through #20's
 * `ApprovalsService`, and spec 201's Approve / Deny on action requests through
 * the local module's `ActionRequestsService`.
 */
@Module({
  imports: [
    NotificationsModule,
    SettingsModule,
    ApprovalsModule,
    LocalModule,
    ProjectsModule,
  ],
  controllers: [TelegramLinkController, TelegramAdminController],
  providers: [
    { provide: TELEGRAM_OPTIONS, useFactory: () => telegramOptionsFromEnv() },
    TelegramClient,
    TelegramLinkingService,
    TelegramApprovalService,
    TelegramActionRequestService,
    TelegramDeliveryService,
    TelegramPoller,
    TelegramIntegrationService,
  ],
  exports: [TelegramPoller, TelegramDeliveryService],
})
export class TelegramModule {}
