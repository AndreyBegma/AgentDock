import type { RunnerHeartbeat } from '@nautelle/shared';
import {
  type CommandResultMessage,
  RUNNER_CLOSE_CODES,
  type RunnerCommands,
  type ServerMessage,
} from '@nautelle/shared/protocol';
import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';

/**
 * How a command sent to a runner ended: a result, or it can never arrive —
 * the runner was revoked or re-paired. A reconnect is neither (#740 D2).
 */
export type CommandOutcome =
  | { kind: 'result'; message: CommandResultMessage }
  | { kind: 'lost' };

/**
 * What a `command.result` met: its waiter, a waiter it already settled (a
 * resend — #740 D3), or nobody (#740 D4: a waiter that gave up, or never
 * was). `name` is the command's, when its waiter is or was known.
 */
export interface Settled {
  outcome: 'settled' | 'repeat' | 'unawaited';
  name: string | null;
}

/** How many ended waiters are remembered, to name and classify a late result. */
export const RECENT_WAITERS_MAX = 1_000;

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
    if (this.socket.readyState <= WebSocket.OPEN) {
      this.socket.close(code, reason);
    }
  }
}

interface Waiter {
  name: string;
  settle: (o: CommandOutcome) => void;
}

/** A waiter that ended: by its result (`settled`), or its caller gave up. */
interface EndedWaiter {
  name: string;
  settled: boolean;
}

/** Closes a socket that authenticated but has not completed `hello`. */
export type EvictPending = (code: number, reason: string) => void;

/**
 * The live socket of each runner, in this process (spec D4: one per runner),
 * and the sockets that authenticated as it but have not sent `hello` yet —
 * re-pairing or revoking closes those too (C-118).
 * The waiters for command results belong to the runner, not to a socket
 * (#740 D2): a reconnect keeps them, and each ends on its result or on its
 * caller's deadline.
 * A single API instance is assumed; several would need a shared registry.
 */
@Injectable()
export class RunnerConnections {
  private readonly live = new Map<string, LiveConnection>();
  private readonly pending = new Map<string, Set<EvictPending>>();
  private readonly waiters = new Map<string, Map<string, Waiter>>();
  /** Ended waiters by `runnerId command-id`, oldest first, bounded. */
  private readonly ended = new Map<string, EndedWaiter>();

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

  /** Registers the waiter for the result of command `id`, named `name`. */
  expect(
    runnerId: string,
    id: string,
    name: string,
    settle: (o: CommandOutcome) => void,
  ): void {
    let waiters = this.waiters.get(runnerId);
    if (!waiters) {
      waiters = new Map();
      this.waiters.set(runnerId, waiters);
    }
    waiters.set(id, { name, settle });
  }

  /** Forgets a waiter — its caller gave up (timeout). */
  forget(runnerId: string, id: string): void {
    const waiter = this.take(runnerId, id);
    if (waiter) this.remember(runnerId, id, waiter.name, false);
  }

  /** Delivers a `command.result` from whichever socket of the runner carried it. */
  settle(runnerId: string, message: CommandResultMessage): Settled {
    const waiter = this.take(runnerId, message.id);
    if (!waiter) {
      const ended = this.ended.get(`${runnerId} ${message.id}`);
      return ended?.settled
        ? { outcome: 'repeat', name: ended.name }
        : { outcome: 'unawaited', name: ended?.name ?? null };
    }
    this.remember(runnerId, message.id, waiter.name, true);
    waiter.settle({ kind: 'result', message });
    return { outcome: 'settled', name: waiter.name };
  }

  private take(runnerId: string, id: string): Waiter | undefined {
    const waiters = this.waiters.get(runnerId);
    const waiter = waiters?.get(id);
    if (!waiters || !waiter) return undefined;
    waiters.delete(id);
    if (waiters.size === 0) this.waiters.delete(runnerId);
    return waiter;
  }

  private remember(
    runnerId: string,
    id: string,
    name: string,
    settled: boolean,
  ): void {
    this.ended.set(`${runnerId} ${id}`, { name, settled });
    while (this.ended.size > RECENT_WAITERS_MAX) {
      const oldest = this.ended.keys().next();
      if (oldest.done) break;
      this.ended.delete(oldest.value);
    }
  }

  /** The runner can never answer (revoked, re-paired): its waiters end now. */
  private loseAll(runnerId: string): void {
    const waiters = [...(this.waiters.get(runnerId)?.entries() ?? [])];
    this.waiters.delete(runnerId);
    for (const [id, waiter] of waiters) {
      this.remember(runnerId, id, waiter.name, false);
      waiter.settle({ kind: 'lost' });
    }
  }

  /**
   * Removes `connection` if it is still the runner's current one. Its
   * waiters stay: the runner replays their results after it reconnects.
   */
  detach(connection: LiveConnection): void {
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

  /**
   * Closes the runner's sockets, live and pre-hello, with `code`. Called on
   * revoke and re-pair: the token is gone, so no result can come back.
   */
  disconnect(runnerId: string, code: number, reason: string): void {
    this.loseAll(runnerId);
    const pending = this.pending.get(runnerId);
    this.pending.delete(runnerId);
    for (const evict of pending ?? []) evict(code, reason);
    const connection = this.live.get(runnerId);
    if (!connection) return;
    this.live.delete(runnerId);
    connection.close(code, reason);
  }
}
