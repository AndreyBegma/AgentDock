import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects';
import { PlanTasksService } from './plan-tasks.service';
import { BoardPlanTasksController, WorkController } from './work.controller';
import { WorkQueryService } from './work-query.service';

/**
 * One Work surface (issue #270, ADR-0028): two read routes over board cards
 * and plan tasks. It writes nothing — the data models stay separate
 * (ADR-0024, ADR-0025) and a plan task changes only in the Planner.
 */
@Module({
  imports: [ProjectsModule],
  controllers: [WorkController, BoardPlanTasksController],
  providers: [PlanTasksService, WorkQueryService],
})
export class WorkModule {}
