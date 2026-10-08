import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity';
import { LiveModule } from '../live/live.module';
import { ProjectsModule } from '../projects';
import { RunsController } from './runs.controller';
import { RunsProjector } from './runs-projector.service';
import { RunsQueryService } from './runs-query.service';

/** Execution history (docs/specs/21): the slot → run projector and the run routes. */
@Module({
  imports: [ActivityModule, ProjectsModule, LiveModule],
  controllers: [RunsController],
  providers: [RunsProjector, RunsQueryService],
  exports: [RunsProjector],
})
export class HistoryModule {}
