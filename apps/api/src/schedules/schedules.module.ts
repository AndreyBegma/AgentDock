import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConditionalModule, ConfigService } from '@nestjs/config';
import { CommandRunsService } from '../control/command-runs.service';
import { ControlService } from '../control/control.service';
import {
  CONTROL_OPTIONS,
  defaultControlOptions,
} from '../control/control-options';
import { OrchestratorSettingsService } from '../control/orchestrator-settings.service';
import { LiveModule } from '../live/live.module';
import { ProjectsModule } from '../projects';
import { RunnersModule } from '../runners/runners.module';
import { SkillsModule } from '../skills';
import { BeforeFire } from './before-fire';
import { ScheduleFireProcessor } from './schedule-fire.processor';
import { ScheduleFirer } from './schedule-firer';
import { ScheduleLive } from './schedule-live';
import { ScheduleMaintenance } from './schedule-maintenance';
import { ScheduleReconciler } from './schedule-reconciler';
import { SCHEDULES_QUEUE, ScheduleTimers } from './schedule-timers';
import { ScheduleWorker } from './schedule-worker';
import { SCHEDULER_OPTIONS, schedulerOptions } from './scheduler-options';
import {
  AdminSchedulesController,
  ProjectSchedulesController,
  SchedulePreviewController,
} from './schedules.controller';
import { SchedulesService } from './schedules.service';
import { SystemJobs } from './system-jobs';

/**
 * Cron schedules (docs/specs/25): the tables' routes, the schedules queue
 * (docs/specs/123) and the system jobs listing. A firing goes through
 * `SkillRunService` (#24) or `ControlService` (#17) — the paths a person's
 * click takes.
 *
 * The queue is registered only with a `REDIS_URL` (spec 123 B19): BullMQ
 * connects as soon as a queue exists, so without one the timers, reconciler
 * and worker see no queue and do nothing.
 *
 * `ControlModule` does not export `ControlService`; it and its helpers are
 * stateless, so this module provides its own instances, as `SkillsModule`
 * does for `CommandRunsService`.
 */
@Module({
  imports: [
    LiveModule,
    ProjectsModule,
    RunnersModule,
    SkillsModule,
    ConditionalModule.registerWhen(
      BullModule.registerQueue({ name: SCHEDULES_QUEUE }),
      (env) => Boolean(env.REDIS_URL?.trim()),
    ),
  ],
  controllers: [
    ProjectSchedulesController,
    SchedulePreviewController,
    AdminSchedulesController,
  ],
  providers: [
    BeforeFire,
    CommandRunsService,
    ControlService,
    OrchestratorSettingsService,
    { provide: CONTROL_OPTIONS, useValue: defaultControlOptions },
    ScheduleFireProcessor,
    ScheduleFirer,
    ScheduleLive,
    ScheduleMaintenance,
    ScheduleReconciler,
    ScheduleTimers,
    ScheduleWorker,
    SchedulesService,
    SystemJobs,
    {
      provide: SCHEDULER_OPTIONS,
      useFactory: schedulerOptions,
      inject: [ConfigService],
    },
  ],
})
export class SchedulesModule {}
