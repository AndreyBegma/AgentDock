import type {
  AnySubscribeMessage,
  PaneMessage,
  RunLogMessage,
  SubscribeErrorMessage,
  TerminalCloseMessage,
  TerminalDataMessage,
  TerminalResizeMessage,
  UnsubscribeMessage,
} from '@agentdock/shared/protocol';
import { Injectable, Logger } from '@nestjs/common';
import { type LiveConnection, RunnerConnections } from './runner-connections';

/** Runner → server messages of a stream the server subscribed to. */
export type RunnerStreamMessage =
  | PaneMessage
  | RunLogMessage
  | SubscribeErrorMessage;
/** Server → runner messages that open and close a stream, and feed an attach (#29). */
export type RunnerStreamRequest =
  | AnySubscribeMessage
  | UnsubscribeMessage
  | TerminalDataMessage
  | TerminalResizeMessage
  | TerminalCloseMessage;
/** Runner → server messages of a terminal attach (#29). */
export type RunnerTerminalMessage = TerminalDataMessage | TerminalCloseMessage;

/**
 * A consumer of runner streams — the pane relay (#18), the skill run log
 * relay (#24). Every listener gets every message and keeps those whose
 * subscription id it opened. Told when a runner's
 * socket comes and goes, because a stream does not survive a reconnect: the
 * runner forgets every subscription and the server subscribes again.
 * Handlers must not throw; work they start is their own to queue.
 */
export interface RunnerStreamListener {
  /** A short name for logs, e.g. 'pane'. */
  readonly name: string;
  /** The runner completed `hello`; its earlier subscriptions are gone. */
  connected(runnerId: string): void;
  /** The runner's current socket closed. */
  disconnected(runnerId: string): void;
  message(runnerId: string, message: RunnerStreamMessage): void;
  /** A terminal attach's bytes or close — the terminal relay (#29) only. */
  terminal?(runnerId: string, message: RunnerTerminalMessage): void;
}

/**
 * Where streaming modules register (`register(this)` in `onModuleInit`) and
 * send their `subscribe` / `unsubscribe`. The gateway reports connections and
 * forwards stream messages here.
 */
@Injectable()
export class RunnerStreams {
  private readonly logger = new Logger(RunnerStreams.name);
  private readonly listeners: RunnerStreamListener[] = [];
  /** The connection each runner was last announced on. */
  private readonly current = new Map<string, LiveConnection>();

  constructor(private readonly connections: RunnerConnections) {}

  register(listener: RunnerStreamListener): void {
    this.listeners.push(listener);
  }

  /** Sends on the runner's open socket; false when it is offline. */
  send(runnerId: string, message: RunnerStreamRequest): boolean {
    return this.connections.get(runnerId)?.send(message) ?? false;
  }

  connected(connection: LiveConnection): void {
    this.current.set(connection.runnerId, connection);
    this.each('connected', (l) => l.connected(connection.runnerId));
  }

  /**
   * A socket closed. Ignored when it was already replaced by a newer one —
   * whose `connected` came first and must not be undone.
   */
  disconnected(connection: LiveConnection): void {
    if (this.current.get(connection.runnerId) !== connection) return;
    this.current.delete(connection.runnerId);
    this.each('disconnected', (l) => l.disconnected(connection.runnerId));
  }

  deliver(runnerId: string, message: RunnerStreamMessage): void {
    this.each(message.type, (l) => l.message(runnerId, message));
  }

  deliverTerminal(runnerId: string, message: RunnerTerminalMessage): void {
    this.each(message.type, (l) => l.terminal?.(runnerId, message));
  }

  private each(
    what: string,
    call: (listener: RunnerStreamListener) => void,
  ): void {
    for (const listener of this.listeners) {
      try {
        call(listener);
      } catch (error) {
        this.logger.error(
          `stream listener ${listener.name} failed on ${what}: ${(error as Error).message}`,
        );
      }
    }
  }
}
