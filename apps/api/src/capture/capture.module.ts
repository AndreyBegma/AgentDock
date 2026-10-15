import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';
import { BoardModule } from '../board';
import { ProjectsModule } from '../projects';
import { RunnersModule } from '../runners/runners.module';
import { CaptureController } from './capture.controller';
import { CaptureService } from './capture.service';
import { CaptureCommands } from './capture-commands';
import { CAPTURE_QUEUE, CaptureQueue } from './capture-queue';
import { CaptureRetention } from './capture-retention.job';
import { CaptureSink } from './capture-sink';
import { CaptureWorker } from './capture-worker';

/**
 * Card capture (issue #244, ADR-0026): manual sessions' new content → a
 * small model on the project's runner → candidate cards in the Board's
 * Inbox. The `card-capture` queue is registered only with a `REDIS_URL`
 * (spec 123 B19); without one nothing is scheduled.
 */
@Module({
  imports: [
    BoardModule,
    ProjectsModule,
    RunnersModule,
    ConditionalModule.registerWhen(
      BullModule.registerQueue({ name: CAPTURE_QUEUE }),
      (env) => Boolean(env.REDIS_URL?.trim()),
    ),
  ],
  controllers: [CaptureController],
  providers: [
    CaptureCommands,
    CaptureQueue,
    CaptureRetention,
    CaptureService,
    CaptureSink,
    CaptureWorker,
  ],
})
export class CaptureModule {}
