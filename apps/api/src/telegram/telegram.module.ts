import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals';
import { BoardModule } from '../board';
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
import { TelegramGuard } from './telegram-guard.service';
import { TelegramIntegrationService } from './telegram-integration.service';
import { TelegramLinkingService } from './telegram-linking.service';
import { TELEGRAM_OPTIONS, telegramOptionsFromEnv } from './telegram-options';
import { TelegramPoller } from './telegram-poller';
import { TelegramProjectService } from './telegram-project.service';
import { TelegramRoutes } from './telegram-routes';
import { TelegramSessionMessageService } from './telegram-session-message.service';

/**
 * The Telegram bot (spec 22 D7–D10): the Bot API client, the one long-polling
 * leader, account linking, and delivery of what `NotificationsModule`'s ledger
 * hands out, with D12's Approve / Request changes buttons through #20's
 * `ApprovalsService`, and spec 201's Approve / Deny on action requests through
 * the local module's `ActionRequestsService`. #500: `TelegramRoutes` routes
 * every update — commands, button prefixes, replies — and `/project` keeps a
 * current project per chat for the Board commands (ADR-0046).
 */
@Module({
  imports: [
    NotificationsModule,
    SettingsModule,
    ApprovalsModule,
    LocalModule,
    ProjectsModule,
    // #489: a card's question answered, and a reply sent to its session.
    BoardModule,
  ],
  controllers: [TelegramLinkController, TelegramAdminController],
  providers: [
    { provide: TELEGRAM_OPTIONS, useFactory: () => telegramOptionsFromEnv() },
    TelegramClient,
    TelegramGuard,
    TelegramLinkingService,
    TelegramApprovalService,
    TelegramActionRequestService,
    TelegramSessionMessageService,
    TelegramProjectService,
    TelegramRoutes,
    TelegramDeliveryService,
    TelegramPoller,
    TelegramIntegrationService,
  ],
  exports: [TelegramPoller, TelegramDeliveryService],
})
export class TelegramModule {}
