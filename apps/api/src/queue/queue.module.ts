import { Module } from '@nestjs/common';
import { FleetModule } from '../fleet';
import { LiveModule } from '../live/live.module';
import { ProjectsModule } from '../projects';
import { RunnersModule } from '../runners/runners.module';
import { QueueController } from './queue.controller';
import { QueueService } from './queue.service';
import { QueueCommands } from './queue-commands';
import { QueueProjector } from './queue-projector.service';
import { QueueQueryService } from './queue-query.service';
import { QueueRecompute } from './queue-recompute';
import { QueueSink } from './queue-sink';

/**
 * The task queue (docs/specs/19): the issue cache, the D3 queue states and
 * their routes. Imports `FleetModule` so the fleet sink registers, and
 * projects each batch, before the queue sink reads rounds and slots.
 */
@Module({
  imports: [ProjectsModule, LiveModule, RunnersModule, FleetModule],
  controllers: [QueueController],
  providers: [
    QueueCommands,
    QueueProjector,
    QueueQueryService,
    QueueRecompute,
    QueueService,
    QueueSink,
  ],
  exports: [QueueProjector],
})
export class QueueModule {}
