import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LiveModule } from '../live/live.module';
import { ProjectsModule } from '../projects';
import {
  ActivityController,
  ProjectActivityController,
} from './activity.controller';
import { ACTIVITY_OPTIONS, activityOptions } from './activity-options';
import { ActivityProjector } from './activity-projector.service';
import { ActivityQueryService } from './activity-query.service';
import { ActivityRetentionJob } from './activity-retention.job';

/** The activity feed (docs/specs/21): projector, retention, read routes. */
@Module({
  imports: [ProjectsModule, LiveModule],
  controllers: [ActivityController, ProjectActivityController],
  providers: [
    {
      provide: ACTIVITY_OPTIONS,
      inject: [ConfigService],
      useFactory: activityOptions,
    },
    ActivityProjector,
    ActivityQueryService,
    ActivityRetentionJob,
  ],
  exports: [ACTIVITY_OPTIONS, ActivityProjector, ActivityQueryService],
})
export class ActivityModule {}
