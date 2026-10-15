import {
  CAPTURE_IDLE_DELAY_MS,
  CAPTURE_SESSION_END_DELAY_MS,
} from '@agentdock/shared';
import {
  captureEventDataSchemas,
  HOOK_SESSION_ENDED_EVENT,
  HOOK_STOPPED_EVENT,
  isCaptureEventType,
  parseHookEvent,
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
import { CaptureService } from './capture.service';
import { CaptureQueue } from './capture-queue';

/**
 * Sink `capture` (issue #244 D2, D4): `hook.stopped` (re)schedules a manual
 * session's extraction for when it goes idle, `hook.session_ended` for two
 * minutes after the end (async hook content lands first); and
 * `cards_extract.finished` settles an extraction.
 *
 * Registered at bootstrap, after the sessions sink (registered in
 * `onModuleInit`): the session row and its `origin` exist when a hook of a
 * new session is read here. The queue holds one job per session, so a
 * replayed batch reschedules the same job.
 */
@Injectable()
export class CaptureSink implements RunnerEventSink, OnApplicationBootstrap {
  readonly name = 'capture';
  private readonly logger = new Logger(CaptureSink.name);

  constructor(
    private readonly sinks: RunnerEventSinks,
    private readonly capture: CaptureService,
    private readonly queue: CaptureQueue,
  ) {}

  onApplicationBootstrap(): void {
    this.sinks.register(this);
  }

  async handle(runnerId: string, events: RunnerEvent[]): Promise<void> {
    for (const event of events) {
      if (isCaptureEventType(event.type)) {
        const parsed = captureEventDataSchemas[event.type].safeParse(
          event.data,
        );
        if (!parsed.success) {
          this.logger.warn(
            `runner ${runnerId}: malformed ${event.type} (seq ${event.seq}), skipped`,
          );
          continue;
        }
        await this.capture.finished(runnerId, parsed.data);
        continue;
      }
      if (
        event.type !== HOOK_STOPPED_EVENT &&
        event.type !== HOOK_SESSION_ENDED_EVENT
      ) {
        continue;
      }
      if (!this.queue.enabled) continue;
      const hook = parseHookEvent(event);
      if (!hook?.ok || hook.event.session.runtime !== 'claude') continue;
      const sessionId = await this.capture.eligibleSession(
        runnerId,
        hook.event.session.id,
      );
      if (!sessionId) continue;
      try {
        await this.queue.schedule(
          sessionId,
          event.type === HOOK_SESSION_ENDED_EVENT
            ? CAPTURE_SESSION_END_DELAY_MS
            : CAPTURE_IDLE_DELAY_MS,
        );
      } catch (error) {
        // Redis down: this hook is not worth failing the batch for; the
        // session's next hook schedules it again.
        this.logger.warn(
          `session ${sessionId}: capture not scheduled: ${(error as Error).message}`,
        );
      }
    }
  }
}
