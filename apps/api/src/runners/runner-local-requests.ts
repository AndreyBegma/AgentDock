import {
  LOCAL_MAX_CONCURRENT_PER_RUNNER,
  LOCAL_REQUEST_TIMEOUT_MS,
  type LocalErrorCode,
  type LocalRequestMessage,
  type LocalResponseMessage,
} from '@agentdock/shared/protocol';
import { Injectable, Logger } from '@nestjs/common';

/**
 * Answers one `local.request` (spec 201 D6–D8). The local module registers
 * its router here, as consumer modules register event sinks: it needs the
 * queue, control and approvals services, which themselves import
 * `RunnersModule`, so the gateway cannot inject it directly.
 */
export interface LocalRequestHandler {
  answer(
    runnerId: string,
    request: LocalRequestMessage,
  ): Promise<LocalResponseMessage>;
}

export const localFailure = (
  id: string,
  code: LocalErrorCode,
  message?: string,
): LocalResponseMessage => ({
  type: 'local.response',
  id,
  ok: false,
  error: {
    code,
    ...(message === undefined ? {} : { message: message.slice(0, 1_000) }),
  },
});

/**
 * Where the gateway hands `local.request` frames. Never throws: every frame
 * gets exactly one `local.response`, at the latest after
 * `LOCAL_REQUEST_TIMEOUT_MS` (`timeout`), the daemon's own deadline too. A
 * runner with `LOCAL_MAX_CONCURRENT_PER_RUNNER` requests in flight gets `busy`.
 */
@Injectable()
export class RunnerLocalRequests {
  private readonly logger = new Logger(RunnerLocalRequests.name);
  private handler: LocalRequestHandler | null = null;
  /** Requests in flight per runner (C-137). */
  private readonly inFlight = new Map<string, number>();

  /** The deadline; a field so tests can shorten it. */
  timeoutMs = LOCAL_REQUEST_TIMEOUT_MS;

  register(handler: LocalRequestHandler): void {
    this.handler = handler;
  }

  async answer(
    runnerId: string,
    request: LocalRequestMessage,
  ): Promise<LocalResponseMessage> {
    const handler = this.handler;
    if (!handler) {
      return localFailure(request.id, 'internal', 'local requests are off');
    }
    const running = this.inFlight.get(runnerId) ?? 0;
    if (running >= LOCAL_MAX_CONCURRENT_PER_RUNNER) {
      return localFailure(request.id, 'busy', 'too many requests in flight');
    }
    this.inFlight.set(runnerId, running + 1);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<LocalResponseMessage>((resolve) => {
      timer = setTimeout(
        () =>
          resolve(
            localFailure(request.id, 'timeout', 'the server did not answer'),
          ),
        this.timeoutMs,
      );
      timer.unref();
    });
    try {
      return await Promise.race([
        handler.answer(runnerId, request).catch((error: unknown) => {
          this.logger.error(
            `local ${request.method} from runner ${runnerId} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return localFailure(request.id, 'internal', 'internal error');
        }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
      const left = (this.inFlight.get(runnerId) ?? 1) - 1;
      if (left > 0) this.inFlight.set(runnerId, left);
      else this.inFlight.delete(runnerId);
    }
  }
}
