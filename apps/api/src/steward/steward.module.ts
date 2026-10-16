import { Global, Module } from '@nestjs/common';
import { BoardModule } from '../board';
import { ProjectsModule } from '../projects';
import { RunnersModule } from '../runners/runners.module';
import { IssueLinkValidator } from './issue-link';
import { StewardController } from './steward.controller';
import { StewardChips } from './steward-chips';
import { StewardCommands } from './steward-commands';
import { StewardDecider } from './steward-decider';
import { StewardIncidents } from './steward-incidents.service';
import { StewardSettingsService } from './steward-settings.service';
import { StewardSink } from './steward-sink';

/**
 * Steward (#447, ADR-0040): the API half — incidents from the runner's
 * observations, the decisions and their commands, escalation, the setting
 * and the incidents API. Global: the board reads its chips and validates an
 * issue link through it; the digest reads the setting and the incidents.
 */
@Global()
@Module({
  imports: [ProjectsModule, RunnersModule, BoardModule],
  controllers: [StewardController],
  providers: [
    IssueLinkValidator,
    StewardChips,
    StewardCommands,
    StewardDecider,
    StewardIncidents,
    StewardSettingsService,
    StewardSink,
  ],
  exports: [
    IssueLinkValidator,
    StewardChips,
    StewardIncidents,
    StewardSettingsService,
  ],
})
export class StewardModule {}
