import { Module } from '@nestjs/common';
import { PlannerModule } from '../planner/planner.module';
import { ProjectsModule } from '../projects';
import { RunnersModule } from '../runners/runners.module';
import { DesignController } from './design.controller';
import { DesignService } from './design.service';
import { DesignCommands } from './design-commands';
import { DesignMockupController } from './design-mockup.controller';
import { DesignSettingsService } from './design-settings.service';
import { UiProfileService } from './ui-profile.service';
import { UiProfileProjector } from './ui-profile-projector';

/**
 * The design stage (docs/specs/223-design-stage.md, ADR-0022): the UI
 * profile, design settings, a task's design, and the sandboxed mockup
 * endpoint. Design turns are the Planner's; profile builds arrive as
 * `uiprofile_build.*` events (`UiProfileProjector`).
 */
@Module({
  imports: [PlannerModule, ProjectsModule, RunnersModule],
  controllers: [DesignController, DesignMockupController],
  providers: [
    DesignCommands,
    DesignService,
    DesignSettingsService,
    UiProfileProjector,
    UiProfileService,
  ],
})
export class DesignModule {}
