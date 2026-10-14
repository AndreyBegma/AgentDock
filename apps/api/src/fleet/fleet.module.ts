import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { ProjectsModule } from '../projects';
import { RunnersModule } from '../runners/runners.module';
import { FleetController } from './fleet.controller';
import { FleetProjector } from './fleet-projector.service';
import { FleetQueryService } from './fleet-query.service';
import { FleetSink } from './fleet-sink';
import { FleetWorkspaceService } from './fleet-workspace.service';
import {
  defaultFleetWorkspaceOptions,
  FLEET_WORKSPACE_OPTIONS,
} from './fleet-workspace-options';

/**
 * Fleet observation (docs/specs/11): projections of fleet events, read-only
 * routes; and the agent workspace's reads (docs/specs/160).
 */
@Module({
  imports: [ProjectsModule, LiveModule, RunnersModule],
  controllers: [FleetController],
  providers: [
    FleetProjector,
    FleetQueryService,
    FleetSink,
    FleetWorkspaceService,
    {
      provide: FLEET_WORKSPACE_OPTIONS,
      useValue: defaultFleetWorkspaceOptions,
    },
  ],
  exports: [FleetProjector],
})
export class FleetModule {}
