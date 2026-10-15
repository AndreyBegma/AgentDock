import { TEXT_NORMALIZE_QUEUE } from '@agentdock/shared';
import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';
import { LiveModule } from '../live/live.module';
import { ProjectsModule } from '../projects';
import { ReadinessModule } from '../readiness';
import { RunnersModule } from '../runners/runners.module';
import { TextController } from './text.controller';
import { TextCommands } from './text-commands';
import { TextNormalizer } from './text-normalizer';
import { TextOwners } from './text-owners';
import { TextQueue } from './text-queue';
import { TextSettingsService } from './text-settings.service';
import { TextSink } from './text-sink';
import { TextViews } from './text-views';
import { TextWorker } from './text-worker';

/**
 * Text normalization (issue #271, ADR-0027): the free text people save is
 * stored in English, translated by a small model on the project's runner.
 * The owner services (Board, Planner, Design) inject `TextNormalizer` to
 * request normalization and register their hooks with `TextOwners`. The
 * `text-normalize` queue is registered only with a `REDIS_URL`.
 *
 * Global, and imported by `AppModule` alone: `ConditionalModule.registerWhen`
 * starts a 5 s timer when this file is loaded, cleared only once
 * `ConfigModule.forRoot` has run. Loaded early — through an owner module or
 * the `../text` barrel — the timer would race the load of the whole module
 * graph and fail a slow boot. Owner services import the classes from their
 * own files, never from the barrel.
 */
@Global()
@Module({
  imports: [
    LiveModule,
    ProjectsModule,
    ReadinessModule,
    RunnersModule,
    ConditionalModule.registerWhen(
      BullModule.registerQueue({ name: TEXT_NORMALIZE_QUEUE }),
      (env) => Boolean(env.REDIS_URL?.trim()),
    ),
  ],
  controllers: [TextController],
  providers: [
    TextCommands,
    TextNormalizer,
    TextOwners,
    TextQueue,
    TextSettingsService,
    TextSink,
    TextViews,
    TextWorker,
  ],
  exports: [TextNormalizer, TextOwners],
})
export class TextModule {}
