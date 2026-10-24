import {
  demoEventDataSchemas,
  isDemoEventType,
  type RunnerEvent,
} from '@nautelle/shared/protocol';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  type RunnerEventSink,
  RunnerEventSinks,
} from '../runners/runner-event-sinks';
import { CardDemosService } from './card-demos.service';

/**
 * Sink `demos` (C-368, ADR-0089): `demo.status` moves a card's demo while it
 * is queued or recording. A malformed event is logged and skipped.
 */
@Injectable()
export class DemosSink implements RunnerEventSink, OnApplicationBootstrap {
  readonly name = 'demos';
  private readonly logger = new Logger(DemosSink.name);

  constructor(
    private readonly sinks: RunnerEventSinks,
    private readonly demos: CardDemosService,
  ) {}

  onApplicationBootstrap(): void {
    this.sinks.register(this);
  }

  async handle(runnerId: string, events: RunnerEvent[]): Promise<void> {
    for (const event of events) {
      if (!isDemoEventType(event.type)) continue;
      const parsed = demoEventDataSchemas[event.type].safeParse(event.data);
      if (!parsed.success) {
        this.logger.warn(
          `runner ${runnerId}: malformed ${event.type} (seq ${event.seq}), skipped`,
        );
        continue;
      }
      await this.demos.status(runnerId, parsed.data);
    }
  }
}
