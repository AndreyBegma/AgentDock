import type { RunnerEvent } from '@agentdock/shared/protocol';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  type RunnerEventSink,
  RunnerEventSinks,
} from '../runners/runner-event-sinks';
import { FleetProjector } from './fleet-projector.service';

/**
 * Feeds every incoming runner batch to the fleet projector, before the batch
 * is stored (spec 11 note 8). The projector skips data that does not fit and
 * throws only on a database failure, which fails the batch so the runner
 * resends it.
 */
@Injectable()
export class FleetSink implements RunnerEventSink, OnModuleInit {
  readonly name = 'fleet';

  constructor(
    private readonly sinks: RunnerEventSinks,
    private readonly projector: FleetProjector,
  ) {}

  onModuleInit(): void {
    this.sinks.register(this);
  }

  handle(runnerId: string, events: RunnerEvent[]): Promise<void> {
    return this.projector.handle(runnerId, events);
  }
}
