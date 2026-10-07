import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { ProjectsModule } from '../projects';
import { FleetController } from './fleet.controller';
import { FleetProjector } from './fleet-projector.service';
import { FleetQueryService } from './fleet-query.service';

/** Fleet observation (docs/specs/11): projections of fleet events, read-only routes. */
@Module({
  imports: [ProjectsModule, LiveModule],
  controllers: [FleetController],
  providers: [FleetProjector, FleetQueryService],
  exports: [FleetProjector],
})
export class FleetModule {}
