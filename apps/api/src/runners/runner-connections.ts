import type { RunnerHeartbeat } from '@nautelle/shared';
import {
  type CommandResultMessage,
  RUNNER_CLOSE_CODES,
  type RunnerCommands,
  type ServerMessage,
} from '@nautelle/shared/protocol';
import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';

/** How a command sent on a connection ended: a result, or the socket went away. */
export type CommandOutcome =
  | { kind: 'result'; message: CommandResultMessage }
  | { kind: 'lost' };

/** Where a runner socket came from: its IP and user agent at upgrade. */
export interface RunnerPeer {
  ip: string | null;
  userAgent: string | null;
}

const UNKNOWN_PEER: RunnerPeer = { ip: null, userAgent: null };

/** One authenticated runner socket that has completed `hello`. */
export class LiveConnection {
  lastBeatAt: number;
  heartbeat: RunnerHeartbeat | null = null;
  private readonly pending = new Map<string, (o: CommandOutcome) => void>();

  constructor(
    readonly runnerId: string,
    private readonly socket: WebSocket,
    readonly connectedAt: number,
    /** What its hello advertised (#233); null = unknown, an older runner. */
    readonly commands: RunnerCommands | null = null,
    readonly peer: RunnerPeer = UNKNOWN_PEER,
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

/** Closes a socket that authenticated but has not completed `hello`. */
export type EvictPending = (code: number, reason: string) => void;

/**
 * The live socket of each runner, in this process (spec D4: one per runner),
 * and the sockets that authenticated as it but have not sent `hello` yet —
 * re-pairing or revoking closes those too (C-118).
 * A single API instance is assumed; several would need a shared registry.
 */
@Injectable()
export class RunnerConnections {
  private readonly live = new Map<string, LiveConnection>();
  private readonly pending = new Map<string, Set<EvictPending>>();

  /**
   * Tracks an authenticated socket until its `hello` completes; returns the
   * release to call once it is attached or closed.
   */
  admit(runnerId: string, evict: EvictPending): () => void {
    let sockets = this.pending.get(runnerId);
    if (!sockets) {
      sockets = new Set();
      this.pending.set(runnerId, sockets);
    }
    sockets.add(evict);
    return () => {
      const current = this.pending.get(runnerId);
      if (!current?.delete(evict)) return;
      if (current.size === 0) this.pending.delete(runnerId);
    };
  }

  /**
   * Makes `connection` the runner's socket; an older one is closed 4409.
   * Returns that older one when it was still open — a live socket taken over,
   * which C-108 reports — and null otherwise: none, or one already closing on
   * its own (a normal reconnect).
   */
  attach(connection: LiveConnection): LiveConnection | null {
    const previous = this.live.get(connection.runnerId);
    this.live.set(connection.runnerId, connection);
    if (!previous || previous === connection) return null;
    const wasOpen = previous.isOpen;
    previous.close(
      RUNNER_CLOSE_CODES.replaced,
      'replaced by a newer connection',
    );
    return wasOpen ? previous : null;
  }

  /** Removes `connection` if it is still the runner's current one. */
  detach(connection: LiveConnection): void {
    connection.lostAll();
    if (this.live.get(connection.runnerId) === connection) {
      this.live.delete(connection.runnerId);
    }
  }

  /** The open connections right now, by runner id. */
  snapshot(): Map<string, LiveConnection> {
    return new Map([...this.live].filter(([, c]) => c.isOpen));
  }

  get(runnerId: string): LiveConnection | undefined {
    const connection = this.live.get(runnerId);
    return connection?.isOpen ? connection : undefined;
  }

  /** Closes the runner's sockets, live and pre-hello, with `code`. */
  disconnect(runnerId: string, code: number, reason: string): void {
    const pending = this.pending.get(runnerId);
    this.pending.delete(runnerId);
    for (const evict of pending ?? []) evict(code, reason);
    const connection = this.live.get(runnerId);
    if (!connection) return;
    this.live.delete(runnerId);
    connection.close(code, reason);
  }
}
