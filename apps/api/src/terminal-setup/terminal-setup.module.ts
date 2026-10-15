import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects';
import { RunnersModule } from '../runners/runners.module';
import { TerminalSetupController } from './terminal-setup.controller';
import { TerminalSetupService } from './terminal-setup.service';

/** The Terminal → Board checklist (issue #281). */
@Module({
  imports: [ProjectsModule, RunnersModule],
  controllers: [TerminalSetupController],
  providers: [TerminalSetupService],
})
export class TerminalSetupModule {}
