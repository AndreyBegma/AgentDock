import { Global, Module } from '@nestjs/common';
import { ProjectsModule } from '../projects';
import { RunUsageFactsService } from './run-usage-facts.service';
import { TokenEconomyController } from './token-economy.controller';
import { TokenEconomyService } from './token-economy.service';
import { TokenEconomyReportService } from './token-economy-report.service';

/**
 * Token economy (#746, ADR-0074): per-card A/B arms per technique, per-run
 * usage facts, and the per-technique report. Global: the board's launch asks
 * `TokenEconomyService` for a card's technique flags.
 */
@Global()
@Module({
  imports: [ProjectsModule],
  controllers: [TokenEconomyController],
  providers: [
    TokenEconomyService,
    TokenEconomyReportService,
    RunUsageFactsService,
  ],
  exports: [TokenEconomyService, RunUsageFactsService],
})
export class TokenEconomyModule {}
