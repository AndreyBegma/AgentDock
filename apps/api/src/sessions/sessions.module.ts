import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { ProjectsModule } from '../projects';
import { RunnersModule } from '../runners/runners.module';
import { SessionsController } from './sessions.controller';
import { SessionsBackfillController } from './sessions-backfill.controller';
import { SessionsBackfillService } from './sessions-backfill.service';
import { SessionsIngestService } from './sessions-ingest.service';
import { SessionsQueryService } from './sessions-query.service';

@Module({
  imports: [RunnersModule, LiveModule, ProjectsModule],
  controllers: [SessionsController, SessionsBackfillController],
  providers: [
    SessionsIngestService,
    SessionsQueryService,
    SessionsBackfillService,
  ],
})
export class SessionsModule {}
