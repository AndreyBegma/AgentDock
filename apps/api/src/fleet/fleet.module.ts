import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { ProjectsModule } from '../projects';
import { RunnersModule } from '../runners/runners.module';
import { FleetController } from './fleet.controller';
import { FleetProjector } from './fleet-projector.service';
import { FleetQueryService } from './fleet-query.service';
import { FleetSink } from './fleet-sink';

/** Fleet observation (docs/specs/11): projections of fleet events, read-only routes. */
@Module({
  imports: [ProjectsModule, LiveModule, RunnersModule],
  controllers: [FleetController],
  providers: [FleetProjector, FleetQueryService, FleetSink],
  exports: [FleetProjector],
})
export class FleetModule {}
