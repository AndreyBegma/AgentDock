import { Module } from '@nestjs/common';
import { BoardModule } from '../board';
import { ControlModule } from '../control/control.module';
import { LiveModule } from '../live/live.module';
import { ProjectsModule } from '../projects';
import { RunnersModule } from '../runners/runners.module';
import { BoardFleetService } from './board-fleet.service';
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
 * routes; the agent workspace's reads (docs/specs/160); and the Board's
 * mirror of slots and ready issues (#282 D4).
 */
@Module({
  imports: [
    BoardModule,
    ControlModule,
    ProjectsModule,
    LiveModule,
    RunnersModule,
  ],
  controllers: [FleetController],
  providers: [
    BoardFleetService,
    FleetProjector,
    FleetQueryService,
    FleetSink,
    FleetWorkspaceService,
    {
      provide: FLEET_WORKSPACE_OPTIONS,
      useValue: defaultFleetWorkspaceOptions,
    },
  ],
  exports: [FleetProjector, FleetQueryService],
})
export class FleetModule {}
