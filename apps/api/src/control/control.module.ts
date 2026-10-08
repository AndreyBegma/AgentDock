import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { ProjectsModule } from '../projects';
import { RunnersModule } from '../runners/runners.module';
import { CommandRunsService } from './command-runs.service';
import { ControlController } from './control.controller';
import { ControlService } from './control.service';
import { CONTROL_OPTIONS, defaultControlOptions } from './control-options';
import { OrchestratorSettingsService } from './orchestrator-settings.service';

/**
 * Orchestrator and slot control (docs/specs/17): the runner commands behind
 * the fleet page's controls, their `command_runs` log and the project's
 * orchestrator settings.
 */
@Module({
  imports: [ProjectsModule, LiveModule, RunnersModule],
  controllers: [ControlController],
  providers: [
    CommandRunsService,
    ControlService,
    OrchestratorSettingsService,
    { provide: CONTROL_OPTIONS, useValue: defaultControlOptions },
  ],
})
export class ControlModule {}
