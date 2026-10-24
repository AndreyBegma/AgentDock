import { Module } from '@nestjs/common';
import { AttachmentsStoreModule } from '../attachments/attachments-store.module';
import { CryptoModule } from '../common/crypto';
import { LiveModule } from '../live/live.module';
import { ProjectsModule } from '../projects';
import { RunnersModule } from '../runners/runners.module';
import { CardDemosService } from './card-demos.service';
import { DemoRunner } from './demo-runner';
import { DemoSettingsService } from './demo-settings.service';
import {
  CardDemosController,
  DemoSettingsController,
  RunnerDemosController,
} from './demos.controller';
import { DemosSink } from './demos-sink';

/**
 * Demo videos of finished cards (C-368, ADR-0090): the per-project settings
 * and Demo env secrets, a card's recordings, the runner's video upload and
 * secret fetch, and the `demo.status` sink. `AttachmentsService` comes from
 * the global `AttachmentsModule`; recording is the runner's (DemoFlow).
 * C-370: `CardDemosService` is exported for the Board, which records a
 * feature card's green head and holds its auto-merge for the demo.
 */
@Module({
  imports: [
    AttachmentsStoreModule,
    CryptoModule,
    LiveModule,
    ProjectsModule,
    RunnersModule,
  ],
  controllers: [
    DemoSettingsController,
    CardDemosController,
    RunnerDemosController,
  ],
  providers: [CardDemosService, DemoRunner, DemoSettingsService, DemosSink],
  exports: [CardDemosService, DemoSettingsService],
})
export class DemosModule {}
