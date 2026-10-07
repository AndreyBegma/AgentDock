import {
  LIVE_CLOSE_CODES,
  type LiveServerMessage,
  type LiveTopic,
  MAX_LIVE_CONNECTIONS_PER_SESSION,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';
import type { AuthUser } from '../auth';

/** One authenticated `/live` socket and what it is subscribed to. */
export class LiveClient {
  readonly topics = new Set<LiveTopic>();
  lastSeenAt: number;

  constructor(
    private readonly socket: WebSocket,
    readonly sessionId: string,
    /** The cookie it authenticated with — what re-validation resolves again. */
    readonly sessionToken: string,
    public user: AuthUser,
    now: number,
  ) {
    this.lastSeenAt = now;
  }

  get isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  send(message: LiveServerMessage): boolean {
    return this.sendRaw(JSON.stringify(message));
  }

  sendRaw(frame: string): boolean {
    if (!this.isOpen) return false;
    this.socket.send(frame);
    return true;
  }

  ping(): void {
    if (this.isOpen) this.socket.ping();
  }

  close(code: number, reason: string): void {
    if (this.socket.readyState <= WebSocket.OPEN) {
      this.socket.close(code, reason);
    }
  }

  terminate(): void {
    this.socket.terminate();
  }
}

/**
 * Every authenticated `/live` socket in this process, by session and by topic.
 * A single API instance is assumed (spec D14); several would need a broker.
 */
@Injectable()
export class LiveConnections {
  private readonly bySession = new Map<string, Set<LiveClient>>();
  private readonly byTopic = new Map<LiveTopic, Set<LiveClient>>();

  /** Registers `client`; false when its session already holds the maximum. */
  add(client: LiveClient): boolean {
    const siblings = this.bySession.get(client.sessionId) ?? new Set();
    if (siblings.size >= MAX_LIVE_CONNECTIONS_PER_SESSION) return false;
    siblings.add(client);
    this.bySession.set(client.sessionId, siblings);
    return true;
  }

  /** Forgets `client` and all its subscriptions. */
  remove(client: LiveClient): void {
    for (const topic of [...client.topics]) this.unsubscribe(client, topic);
    const siblings = this.bySession.get(client.sessionId);
    if (!siblings?.delete(client)) return;
    if (siblings.size === 0) this.bySession.delete(client.sessionId);
  }

  subscribe(client: LiveClient, topic: LiveTopic): void {
    client.topics.add(topic);
    const subscribers = this.byTopic.get(topic) ?? new Set();
    subscribers.add(client);
    this.byTopic.set(topic, subscribers);
  }

  unsubscribe(client: LiveClient, topic: LiveTopic): void {
    client.topics.delete(topic);
    const subscribers = this.byTopic.get(topic);
    if (!subscribers?.delete(client)) return;
    if (subscribers.size === 0) this.byTopic.delete(topic);
  }

  subscribers(topic: LiveTopic): LiveClient[] {
    return [...(this.byTopic.get(topic) ?? [])];
  }

  /** The sockets of each connected session, by session id. */
  sessions(): Map<string, LiveClient[]> {
    return new Map([...this.bySession].map(([id, set]) => [id, [...set]]));
  }

  all(): LiveClient[] {
    return [...this.bySession.values()].flatMap((set) => [...set]);
  }

  /** Closes every socket of a session that is no longer valid. */
  endSession(sessionId: string): void {
    for (const client of [...(this.bySession.get(sessionId) ?? [])]) {
      this.remove(client);
      client.close(LIVE_CLOSE_CODES.unauthorized, 'session ended');
    }
  }
}
