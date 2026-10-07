import type { RunnerHeartbeat } from '@agentdock/shared';
import {
  type CommandResultMessage,
  RUNNER_CLOSE_CODES,
  type ServerMessage,
} from '@agentdock/shared/protocol';
import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';

/** How a command sent on a connection ended: a result, or the socket went away. */
export type CommandOutcome =
  | { kind: 'result'; message: CommandResultMessage }
  | { kind: 'lost' };

/** One authenticated runner socket that has completed `hello`. */
export class LiveConnection {
  lastBeatAt: number;
  heartbeat: RunnerHeartbeat | null = null;
  private readonly pending = new Map<string, (o: CommandOutcome) => void>();

  constructor(
    readonly runnerId: string,
    private readonly socket: WebSocket,
    readonly connectedAt: number,
  ) {
    this.lastBeatAt = connectedAt;
  }

  get isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  send(message: ServerMessage): boolean {
    if (!this.isOpen) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  close(code: number, reason: string): void {
    this.lostAll();
    if (this.socket.readyState <= WebSocket.OPEN) {
      this.socket.close(code, reason);
    }
  }

  /** Registers the waiter for a command's result. */
  expect(id: string, settle: (o: CommandOutcome) => void): void {
    this.pending.set(id, settle);
  }

  /** Forgets a waiter — its caller gave up (timeout). */
  forget(id: string): void {
    this.pending.delete(id);
  }

  /** Delivers a `command.result`; `false` when nobody waits for that id. */
  settle(message: CommandResultMessage): boolean {
    const waiter = this.pending.get(message.id);
    if (!waiter) return false;
    this.pending.delete(message.id);
    waiter({ kind: 'result', message });
    return true;
  }

  /** The socket is gone: every result still awaited can never arrive. */
  lostAll(): void {
    const waiters = [...this.pending.values()];
    this.pending.clear();
    for (const waiter of waiters) waiter({ kind: 'lost' });
  }
}

/**
 * The live socket of each runner, in this process (spec D4: one per runner).
 * A single API instance is assumed; several would need a shared registry.
 */
@Injectable()
export class RunnerConnections {
  private readonly live = new Map<string, LiveConnection>();

  /** Makes `connection` the runner's socket; an older one is closed 4409. */
  attach(connection: LiveConnection): void {
    const previous = this.live.get(connection.runnerId);
    this.live.set(connection.runnerId, connection);
    if (previous && previous !== connection) {
      previous.close(
        RUNNER_CLOSE_CODES.replaced,
        'replaced by a newer connection',
      );
    }
  }

  /** Removes `connection` if it is still the runner's current one. */
  detach(connection: LiveConnection): void {
    connection.lostAll();
    if (this.live.get(connection.runnerId) === connection) {
      this.live.delete(connection.runnerId);
    }
  }

  get(runnerId: string): LiveConnection | undefined {
    const connection = this.live.get(runnerId);
    return connection?.isOpen ? connection : undefined;
  }

  /** Closes the runner's socket, if any, with `code`. */
  disconnect(runnerId: string, code: number, reason: string): void {
    const connection = this.live.get(runnerId);
    if (!connection) return;
    this.live.delete(runnerId);
    connection.close(code, reason);
  }
}
