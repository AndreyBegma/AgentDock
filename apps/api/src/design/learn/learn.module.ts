import { UI_PROFILE_LEARN_QUEUE } from '@nautelle/shared';
import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';
import { LiveModule } from '../../live/live.module';
import { ReadinessModule } from '../../readiness';
import { RunnersModule } from '../../runners/runners.module';
import { UiProfileLearnCommands } from './learn-commands';
import { UiProfileLearnQueue } from './learn-queue';
import { UiProfileLearnWorker } from './learn-worker';
import { UiProfileLearner } from './ui-profile-learner';

/**
 * The UI profile's memory (#752, ADR-0075 §6): after an approval, a
 * `uiprofile.learn` call on the project's runner teaches the profile. The
 * design flow injects `UiProfileLearner` to request it. The
 * `ui-profile-learn` queue is registered only with a `REDIS_URL`.
 *
 * Global, and imported by `AppModule` alone, for the reason `AssessModule`
 * is (#322): `ConditionalModule.registerWhen` starts a 5 s timer when this
 * file is loaded, cleared only once `ConfigModule.forRoot` has run — loaded
 * early, through a feature module or a barrel, it fails a slow boot (#302,
 * #320). Callers import `UiProfileLearner` from its own file.
 */
@Global()
@Module({
  imports: [
    LiveModule,
    ReadinessModule,
    RunnersModule,
    ConditionalModule.registerWhen(
      BullModule.registerQueue({ name: UI_PROFILE_LEARN_QUEUE }),
      (env) => Boolean(env.REDIS_URL?.trim()),
    ),
  ],
  providers: [
    UiProfileLearnCommands,
    UiProfileLearnQueue,
    UiProfileLearnWorker,
    UiProfileLearner,
  ],
  exports: [UiProfileLearner],
})
export class UiProfileLearnModule {}
