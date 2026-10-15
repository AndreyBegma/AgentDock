import { Module } from '@nestjs/common';
import { BoardModule } from '../board/board.module';
import { PlannerModule } from '../planner/planner.module';
import { ProjectsModule } from '../projects';
import { RunnersModule } from '../runners/runners.module';
import { CardDesignController } from './card-design.controller';
import { DesignController } from './design.controller';
import { DesignService } from './design.service';
import { DesignCommands } from './design-commands';
import { DesignMockupController } from './design-mockup.controller';
import { DesignSettingsService } from './design-settings.service';
import { DesignStopService } from './design-stop.service';
import { UiProfileService } from './ui-profile.service';
import { UiProfileProjector } from './ui-profile-projector';

/**
 * The design stage (docs/specs/223-design-stage.md, ADR-0022): the UI
 * profile, design settings, a task's design, and the sandboxed mockup
 * endpoint. Design turns are the Planner's; profile builds arrive as
 * `uiprofile_build.*` events (`UiProfileProjector`). A board card's design
 * (#243, ADR-0025) runs the same flow; approving it may start the card's
 * round 1 (`BoardModule`). Stop (#275) cancels the turn or leaves the build.
 */
@Module({
  imports: [BoardModule, PlannerModule, ProjectsModule, RunnersModule],
  controllers: [CardDesignController, DesignController, DesignMockupController],
  providers: [
    DesignCommands,
    DesignService,
    DesignSettingsService,
    DesignStopService,
    UiProfileProjector,
    UiProfileService,
  ],
})
export class DesignModule {}
