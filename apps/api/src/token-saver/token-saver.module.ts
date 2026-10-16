import { Global, Module } from '@nestjs/common';
import { ProjectsModule } from '../projects';
import { RunnersModule } from '../runners/runners.module';
import { TokenSaverController } from './token-saver.controller';
import { TokenSaverService } from './token-saver.service';
import { TokenSaverSink } from './token-saver-sink';
import { TokenSaverSummaryService } from './token-saver-summary.service';

/**
 * Token saver (#445, ADR-0039): the project setting, the summary, and the
 * runner's `filter.stats` ingest. Global: every launch sender — Board,
 * Skills, Planner, Design, Assess, Capture, Text, Control — injects
 * `TokenSaverService` to decide what its launch command carries.
 */
@Global()
@Module({
  imports: [ProjectsModule, RunnersModule],
  controllers: [TokenSaverController],
  providers: [TokenSaverService, TokenSaverSink, TokenSaverSummaryService],
  exports: [TokenSaverService],
})
export class TokenSaverModule {}
