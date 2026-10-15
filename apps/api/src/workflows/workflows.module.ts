import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProjectsModule } from '../projects';
import { RunnersModule } from '../runners/runners.module';
import { SessionsModule } from '../sessions/sessions.module';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsIngestService } from './workflows-ingest.service';
import { WORKFLOWS_OPTIONS, workflowsOptions } from './workflows-options';
import { WorkflowsProjector } from './workflows-projector.service';
import { WorkflowsQueryService } from './workflows-query.service';

/**
 * Workflows analytics (#161): the runner-event sink, the projector and the
 * `/workflows` routes. `SessionsModule` is imported so its sink registers
 * first: this one reads the session rows that one writes.
 */
@Module({
  imports: [RunnersModule, ProjectsModule, SessionsModule],
  controllers: [WorkflowsController],
  providers: [
    {
      provide: WORKFLOWS_OPTIONS,
      inject: [ConfigService],
      useFactory: workflowsOptions,
    },
    WorkflowsIngestService,
    WorkflowsProjector,
    WorkflowsQueryService,
  ],
  exports: [WorkflowsProjector],
})
export class WorkflowsModule {}
