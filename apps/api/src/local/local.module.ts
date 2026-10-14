import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals';
import { BoardModule } from '../board';
import { ControlModule } from '../control';
import { LiveModule } from '../live/live.module';
import { NotificationsModule } from '../notifications';
import { ProjectsModule } from '../projects';
import { QueueModule } from '../queue';
import { RunnersModule } from '../runners/runners.module';
import { ActionRequestExpiryJob } from './action-request-expiry.job';
import { ActionRequestsController } from './action-requests.controller';
import { ActionRequestsService } from './action-requests.service';
import { LocalHandlers } from './local-handlers';
import { LOCAL_OPTIONS, localOptionsFromEnv } from './local-options';
import { LocalRequestRouter } from './local-request-router';

/**
 * The Claude Code integration's server side (spec 201, ADR-0020): the
 * `local.request` router the runner gateway hands requests to, the action
 * requests a session asks a person for, and their expiry job.
 *
 * Imports `QueueModule` and `ControlModule` for their write services rather
 * than providing them again: a second `QueueCommands` is a second instance the
 * queue controller does not use. Exports `ActionRequestsService` for the
 * Telegram buttons.
 */
@Module({
  imports: [
    RunnersModule,
    ProjectsModule,
    ApprovalsModule,
    LiveModule,
    NotificationsModule,
    QueueModule,
    ControlModule,
    // Issue #242: `card.finish`, the card worker's `finish_card`.
    BoardModule,
  ],
  controllers: [ActionRequestsController],
  providers: [
    { provide: LOCAL_OPTIONS, useFactory: () => localOptionsFromEnv() },
    ActionRequestsService,
    ActionRequestExpiryJob,
    LocalHandlers,
    LocalRequestRouter,
  ],
  exports: [ActionRequestsService],
})
export class LocalModule {}
