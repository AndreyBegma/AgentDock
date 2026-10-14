import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals';
import { CommandRunsService } from '../control/command-runs.service';
import { ControlService } from '../control/control.service';
import {
  CONTROL_OPTIONS,
  defaultControlOptions,
} from '../control/control-options';
import { OrchestratorSettingsService } from '../control/orchestrator-settings.service';
import { LiveModule } from '../live/live.module';
import { NotificationsModule } from '../notifications';
import { ProjectsModule } from '../projects';
import { QueueService } from '../queue/queue.service';
import { QueueCommands } from '../queue/queue-commands';
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
 * `QueueModule` and `ControlModule` export nothing, so their stateless write
 * services are provided here again (each a plain class over Prisma, audit,
 * live and the runner command service) rather than changing those modules.
 * Exports `ActionRequestsService` for the Telegram buttons.
 */
@Module({
  imports: [
    RunnersModule,
    ProjectsModule,
    ApprovalsModule,
    LiveModule,
    NotificationsModule,
  ],
  controllers: [ActionRequestsController],
  providers: [
    { provide: LOCAL_OPTIONS, useFactory: () => localOptionsFromEnv() },
    { provide: CONTROL_OPTIONS, useValue: defaultControlOptions },
    CommandRunsService,
    OrchestratorSettingsService,
    ControlService,
    QueueCommands,
    QueueService,
    ActionRequestsService,
    ActionRequestExpiryJob,
    LocalHandlers,
    LocalRequestRouter,
  ],
  exports: [ActionRequestsService],
})
export class LocalModule {}
