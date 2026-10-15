import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { LiveModule } from '../live/live.module';
import { ProjectsModule } from '../projects';
import { AttachmentStore } from './attachment-store';
import {
  AttachmentsController,
  RunnerAttachmentsController,
} from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { AttachmentsStoreModule } from './attachments-store.module';
import { ATTACHMENTS_QUEUE, AttachmentsSweep } from './attachments-sweep';
import { uploadOptions } from './upload-storage';

/**
 * Board card attachments (issue #309, ADR-0031): the store port and its
 * filesystem implementation, the upload, content and delete routes, the
 * runner's download route and the daily sweep. `AttachmentsService` is
 * exported for the board, which claims uploads inside its own transactions.
 * The sweep's queue is registered only with a `REDIS_URL`, as the schedules
 * queue is.
 *
 * Global, and imported by `AppModule` alone, as `forRoot()` after
 * `ConfigModule.forRoot` (see `TextModule`): `ConditionalModule.registerWhen`
 * starts a 5 s timer when it is called, cleared only once the config has
 * loaded. Called while the module graph is still loading, the timer would
 * race it and fail a slow boot — so it is called in `forRoot`, never at file
 * load. Board services import the classes from their own files.
 */
@Global()
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest dynamic module is a class with a static `forRoot`.
export class AttachmentsModule {
  static forRoot(): DynamicModule {
    return {
      module: AttachmentsModule,
      global: true,
      imports: [
        LiveModule,
        ProjectsModule,
        MulterModule.registerAsync({
          imports: [AttachmentsStoreModule],
          inject: [AttachmentStore],
          useFactory: uploadOptions,
        }),
        AttachmentsStoreModule,
        ConditionalModule.registerWhen(
          BullModule.registerQueue({ name: ATTACHMENTS_QUEUE }),
          (env) => Boolean(env.REDIS_URL?.trim()),
        ),
      ],
      controllers: [AttachmentsController, RunnerAttachmentsController],
      providers: [AttachmentsService, AttachmentsSweep],
      exports: [AttachmentsService, AttachmentsSweep],
    };
  }
}
