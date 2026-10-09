import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { ScheduleFirer } from './schedule-firer';
import { ScheduleLive } from './schedule-live';
import { SchedulerService } from './scheduler.service';
import { SCHEDULER_OPTIONS, schedulerOptions } from './scheduler-options';
import {
  AdminSchedulesController,
  ProjectSchedulesController,
  SchedulePreviewController,
} from './schedules.controller';
import { SchedulesService } from './schedules.service';
import { SystemJobs } from './system-jobs';

/**
 * Cron schedules (docs/specs/25): the tables' routes, the scheduler loop and
 * the system jobs listing. A firing goes through `SkillRunService` (#24) or
 * `ControlService` (#17) — the paths a person's click takes.
 *
 * `ControlModule` does not export `ControlService`; it and its helpers are
 * stateless, so this module provides its own instances, as `SkillsModule`
 * does for `CommandRunsService`.
 */
@Module({
  imports: [LiveModule, ProjectsModule, RunnersModule, SkillsModule],
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
    ScheduleFirer,
    ScheduleLive,
    SchedulerService,
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
