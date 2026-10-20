import {
  isTextEventType,
  type RunnerEvent,
  textEventDataSchemas,
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
import { TextNormalizer } from './text-normalizer';

/** Sink `text`: `text_normalize.finished` settles a request (issue #271 D8). */
@Injectable()
export class TextSink implements RunnerEventSink, OnApplicationBootstrap {
  readonly name = 'text';
  private readonly logger = new Logger(TextSink.name);

  constructor(
    private readonly sinks: RunnerEventSinks,
    private readonly normalizer: TextNormalizer,
  ) {}

  onApplicationBootstrap(): void {
    this.sinks.register(this);
  }

  async handle(runnerId: string, events: RunnerEvent[]): Promise<void> {
    for (const event of events) {
      if (!isTextEventType(event.type)) continue;
      const parsed = textEventDataSchemas[event.type].safeParse(event.data);
      if (!parsed.success) {
        this.logger.warn(
          `runner ${runnerId}: malformed ${event.type} (seq ${event.seq}), skipped`,
        );
        continue;
      }
      await this.normalizer.finished(runnerId, parsed.data);
    }
  }
}
