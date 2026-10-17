import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals';
import { AuthModule } from '../auth';
import { BoardModule } from '../board';
import { ControlModule } from '../control';
import { LocalModule } from '../local';
import { NotificationsModule } from '../notifications';
import { PlannerModule } from '../planner';
import { ProjectsModule } from '../projects';
import { SettingsModule } from '../settings/settings.module';
import {
  SPEECH_TO_TEXT_OPTIONS,
  SpeechToText,
  speechToTextOptionsFromEnv,
} from './speech-to-text';
import {
  TelegramAdminController,
  TelegramLinkController,
  TelegramWebAppController,
} from './telegram.controller';
import { TelegramActionRequestService } from './telegram-action-request.service';
import { TelegramApprovalService } from './telegram-approval.service';
import { TelegramBoardService } from './telegram-board.service';
import { TelegramCardService } from './telegram-card.service';
import { TelegramClient } from './telegram-client';
import { TelegramDeliveryService } from './telegram-delivery.service';
import { TelegramGuard } from './telegram-guard.service';
import { TelegramIntakeService } from './telegram-intake.service';
import { TelegramIntegrationService } from './telegram-integration.service';
import { TelegramLinkingService } from './telegram-linking.service';
import { TELEGRAM_OPTIONS, telegramOptionsFromEnv } from './telegram-options';
import { TelegramPoller } from './telegram-poller';
import { TelegramProjectService } from './telegram-project.service';
import { TelegramRoutes } from './telegram-routes';
import { TelegramSessionMessageService } from './telegram-session-message.service';
import { TelegramWebAppService } from './telegram-web-app.service';

/**
 * The Telegram bot (spec 22 D7–D10): the Bot API client, the one long-polling
 * leader, account linking, and delivery of what `NotificationsModule`'s ledger
 * hands out, with D12's Approve / Request changes buttons through #20's
 * `ApprovalsService`, and spec 201's Approve / Deny on action requests through
 * the local module's `ActionRequestsService`. #500: `TelegramRoutes` routes
 * every update — commands, button prefixes, replies — and `/project` keeps a
 * current project per chat for the Board commands (ADR-0046). #574: `/new`
 * runs the New work intake (`TelegramIntakeService`). #578: a card's review
 * actions on the card messages and notifications (`TelegramCardService`).
 * #580: the Mini App signs in with its `initData` (`TelegramWebAppService`)
 * and gets the web session `AuthModule` issues. #594: `/new` takes photos,
 * stored through the global `AttachmentsService`, and voice messages,
 * transcribed by `SpeechToText`.
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
    // #574: `/new` runs the New work intake through the planner's services.
    PlannerModule,
    // #578: a fleet card's worker messaged through its slot.
    ControlModule,
    // #580: the Mini App's sign-in issues the ordinary web session.
    AuthModule,
  ],
  controllers: [
    TelegramLinkController,
    TelegramAdminController,
    TelegramWebAppController,
  ],
  providers: [
    { provide: TELEGRAM_OPTIONS, useFactory: () => telegramOptionsFromEnv() },
    TelegramClient,
    {
      provide: SPEECH_TO_TEXT_OPTIONS,
      useFactory: () => speechToTextOptionsFromEnv(),
    },
    SpeechToText,
    TelegramGuard,
    TelegramLinkingService,
    TelegramApprovalService,
    TelegramActionRequestService,
    TelegramSessionMessageService,
    TelegramProjectService,
    TelegramBoardService,
    TelegramIntakeService,
    TelegramCardService,
    TelegramWebAppService,
    TelegramRoutes,
    TelegramDeliveryService,
    TelegramPoller,
    TelegramIntegrationService,
  ],
  exports: [TelegramPoller, TelegramDeliveryService],
})
export class TelegramModule {}
