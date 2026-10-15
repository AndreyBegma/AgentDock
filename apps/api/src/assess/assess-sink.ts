import {
  assessEventDataSchemas,
  isAssessEventType,
  type RunnerEvent,
} from '@agentdock/shared/protocol';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  type RunnerEventSink,
  RunnerEventSinks,
} from '../runners/runner-event-sinks';
import { CardAssessor } from './card-assessor';

/** Sink `assess`: `card_assess.finished` settles a card's assessment (#322 D6). */
@Injectable()
export class AssessSink implements RunnerEventSink, OnApplicationBootstrap {
  readonly name = 'assess';
  private readonly logger = new Logger(AssessSink.name);

  constructor(
    private readonly sinks: RunnerEventSinks,
    private readonly assessor: CardAssessor,
  ) {}

  onApplicationBootstrap(): void {
    this.sinks.register(this);
  }

  async handle(runnerId: string, events: RunnerEvent[]): Promise<void> {
    for (const event of events) {
      if (!isAssessEventType(event.type)) continue;
      const parsed = assessEventDataSchemas[event.type].safeParse(event.data);
      if (!parsed.success) {
        this.logger.warn(
          `runner ${runnerId}: malformed ${event.type} (seq ${event.seq}), skipped`,
        );
        continue;
      }
      await this.assessor.finished(runnerId, parsed.data);
    }
  }
}
