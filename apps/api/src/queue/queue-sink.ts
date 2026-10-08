import type { RunnerEvent } from '@agentdock/shared/protocol';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  type RunnerEventSink,
  RunnerEventSinks,
} from '../runners/runner-event-sinks';
import { QueueProjector } from './queue-projector.service';

/**
 * Feeds every incoming runner batch to the queue projector. Registered after
 * the fleet sink — `QueueModule` imports `FleetModule`, whose `onModuleInit`
 * therefore runs first — so a batch's rounds and slots are projected before
 * the queue reads them.
 */
@Injectable()
export class QueueSink implements RunnerEventSink, OnModuleInit {
  readonly name = 'queue';

  constructor(
    private readonly sinks: RunnerEventSinks,
    private readonly projector: QueueProjector,
  ) {}

  onModuleInit(): void {
    this.sinks.register(this);
  }

  handle(runnerId: string, events: RunnerEvent[]): Promise<void> {
    return this.projector.handle(runnerId, events);
  }
}
