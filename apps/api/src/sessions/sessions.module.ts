import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { ProjectsModule } from '../projects';
import { RunnersModule } from '../runners/runners.module';
import { SessionsController } from './sessions.controller';
import { SessionsIngestService } from './sessions-ingest.service';
import { SessionsQueryService } from './sessions-query.service';

@Module({
  imports: [RunnersModule, LiveModule, ProjectsModule],
  controllers: [SessionsController],
  providers: [SessionsIngestService, SessionsQueryService],
})
export class SessionsModule {}
