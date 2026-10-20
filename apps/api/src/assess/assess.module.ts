import { CARD_ASSESS_QUEUE } from '@nautelle/shared';
import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';
import { LiveModule } from '../live/live.module';
import { ReadinessModule } from '../readiness';
import { RunnersModule } from '../runners/runners.module';
import { AssessCommands } from './assess-commands';
import { AssessQueue } from './assess-queue';
import { AssessSink } from './assess-sink';
import { AssessWorker } from './assess-worker';
import { CardAssessor } from './card-assessor';

/**
 * Card model assessment (issue #322 D5–D8, ADR-0032): a `haiku` call on the
 * project's runner recommends a model for a card's work and design. The
 * board injects `CardAssessor` to request it after a save and once the
 * save's normalization settled. The `card-assess` queue is registered only
 * with a `REDIS_URL`.
 *
 * Global, and imported by `AppModule` alone, for the reason `TextModule`
 * is: `ConditionalModule.registerWhen` starts a 5 s timer when this file is
 * loaded, cleared only once `ConfigModule.forRoot` has run — loaded early,
 * through a feature module or a barrel, it fails a slow boot (#302, #320).
 * Callers import `CardAssessor` from its own file.
 */
@Global()
@Module({
  imports: [
    LiveModule,
    ReadinessModule,
    RunnersModule,
    ConditionalModule.registerWhen(
      BullModule.registerQueue({ name: CARD_ASSESS_QUEUE }),
      (env) => Boolean(env.REDIS_URL?.trim()),
    ),
  ],
  providers: [
    AssessCommands,
    AssessQueue,
    AssessSink,
    AssessWorker,
    CardAssessor,
  ],
  exports: [CardAssessor],
})
export class AssessModule {}
