import type { RunnerEvent } from '@agentdock/shared/protocol';
import { Injectable, Logger } from '@nestjs/common';

/**
 * A consumer of runner events beyond the raw `events` table: sessions (#12)
 * and fleet (#11). A sink filters the types it owns and ignores the rest.
 */
export interface RunnerEventSink {
  /** A short name for logs, e.g. 'sessions', 'fleet'. */
  readonly name: string;
  /**
   * Called with every incoming batch BEFORE it is stored. Must be idempotent:
   * the same batch can arrive again after a failure or a reconnect.
   * Bad or unknown data → log and skip, never throw. Throw only for
   * infrastructure failures (database down, transaction aborted); that fails the
   * whole batch and the runner resends it.
   */
  handle(runnerId: string, events: RunnerEvent[]): Promise<void>;
}

/**
 * Where consumer modules register their sinks: import `RunnersModule` and call
 * `register(this)` in `onModuleInit`.
 */
@Injectable()
export class RunnerEventSinks {
  private readonly logger = new Logger(RunnerEventSinks.name);
  private readonly sinks: RunnerEventSink[] = [];

  register(sink: RunnerEventSink): void {
    this.sinks.push(sink);
  }

  /** Runs every sink in registration order. The first throw is logged with the sink's name and rethrown. */
  async dispatch(runnerId: string, events: RunnerEvent[]): Promise<void> {
    for (const sink of this.sinks) {
      try {
        await sink.handle(runnerId, events);
      } catch (error) {
        this.logger.error(
          `sink ${sink.name} failed on a batch of ${events.length} from runner ${runnerId}`,
          error instanceof Error ? error.stack : String(error),
        );
        throw error;
      }
    }
  }
}
