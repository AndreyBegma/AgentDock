import { PREFIX_PROPOSE_QUEUE, RULES_COMPRESS_QUEUE } from '@nautelle/shared';
import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';
import { BoardModule } from '../board/board.module';
import { LiveModule } from '../live/live.module';
import { ProjectsModule } from '../projects';
import { ReadinessModule } from '../readiness';
import { RunnersModule } from '../runners/runners.module';
import { PrefixController } from './prefix.controller';
import { PrefixCommands } from './prefix-commands';
import { PrefixLaunchService } from './prefix-launch';
import { PrefixOverlaysService } from './prefix-overlays.service';
import { PrefixProposer } from './prefix-proposer';
import { PrefixQueues } from './prefix-queues';
import { PrefixRuns } from './prefix-runs';
import { PrefixSink } from './prefix-sink';
import { PrefixSummaryService } from './prefix-summary.service';
import { PrefixWorker } from './prefix-worker';
import { RulesCompressor } from './rules-compressor';

/**
 * The launch prefix (#751, ADR-0075): the runner's measurement, the Prefix
 * section, the overlays and their proposals, the rules compression, and the
 * card launch's frozen prefix. `BoardRoundsService` injects
 * `PrefixLaunchService`, `ProjectRulesService` injects `RulesCompressor`.
 *
 * Global, and imported by `AppModule` alone, for the reason `AssessModule`
 * is (#322): `ConditionalModule.registerWhen` starts a 5 s timer when this
 * file is loaded, cleared only once `ConfigModule.forRoot` has run. Callers
 * import the classes from their own files.
 */
@Global()
@Module({
  imports: [
    BoardModule,
    LiveModule,
    ProjectsModule,
    ReadinessModule,
    RunnersModule,
    ConditionalModule.registerWhen(
      BullModule.registerQueue(
        { name: RULES_COMPRESS_QUEUE },
        { name: PREFIX_PROPOSE_QUEUE },
      ),
      (env) => Boolean(env.REDIS_URL?.trim()),
    ),
  ],
  controllers: [PrefixController],
  providers: [
    PrefixCommands,
    PrefixLaunchService,
    PrefixOverlaysService,
    PrefixProposer,
    PrefixQueues,
    PrefixRuns,
    PrefixSink,
    PrefixSummaryService,
    PrefixWorker,
    RulesCompressor,
  ],
  exports: [PrefixLaunchService, RulesCompressor],
})
export class PrefixModule {}
