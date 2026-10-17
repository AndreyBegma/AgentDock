import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { ProjectsModule } from '../projects';
import { RunnersModule } from '../runners/runners.module';
import { SessionMessageModule } from '../session-message/session-message.module';
import { CommandRunsService } from './command-runs.service';
import { ControlController } from './control.controller';
import { ControlService } from './control.service';
import { CONTROL_OPTIONS, defaultControlOptions } from './control-options';
import { OrchestratorSettingsService } from './orchestrator-settings.service';
import { SlotSessionMessages } from './slot-session-message.service';

/**
 * Orchestrator and slot control (docs/specs/17): the runner commands behind
 * the fleet page's controls, their `command_runs` log and the project's
 * orchestrator settings.
 */
@Module({
  imports: [ProjectsModule, LiveModule, RunnersModule, SessionMessageModule],
  controllers: [ControlController],
  providers: [
    CommandRunsService,
    ControlService,
    SlotSessionMessages,
    OrchestratorSettingsService,
    { provide: CONTROL_OPTIONS, useValue: defaultControlOptions },
  ],
  exports: [ControlService],
})
export class ControlModule {}
