import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SessionService } from '../auth';
import { type LiveClient, LiveConnections } from './live-connections';
import { LIVE_OPTIONS, type LiveOptions } from './live-options';
import { TopicAuthorizerRegistry } from './topic-authorizer.registry';

/**
 * The two clocks of `/live`: keepalive (D13) and session re-validation (D10).
 * Re-validation goes through `SessionService.resolve`, so a disabled user, a
 * revoked or expired session, and a role change (which ends the sessions)
 * all close the socket 4401 within one interval. `resolve` also refreshes the
 * session's `lastSeenAt` about once a minute: an open tab counts as activity.
 */
@Injectable()
export class LiveMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveMonitor.name);
  private keepaliveTimer: NodeJS.Timeout | undefined;
  private revalidateTimer: NodeJS.Timeout | undefined;
  private revalidating = false;

  constructor(
    private readonly connections: LiveConnections,
    private readonly sessions: SessionService,
    private readonly authorizers: TopicAuthorizerRegistry,
    @Inject(LIVE_OPTIONS) private readonly options: LiveOptions,
  ) {}

  onModuleInit(): void {
    this.keepaliveTimer = setInterval(
      () => this.keepalive(),
      this.options.pingIntervalMs,
    );
    this.keepaliveTimer.unref();
    this.revalidateTimer = setInterval(() => {
      void this.revalidate();
    }, this.options.revalidateMs);
    this.revalidateTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.keepaliveTimer);
    clearInterval(this.revalidateTimer);
  }

  /** Drops sockets silent past the idle timeout, pings the rest. */
  keepalive(now = Date.now()): void {
    for (const client of this.connections.all()) {
      if (now - client.lastSeenAt > this.options.idleTimeoutMs) {
        this.connections.remove(client);
        client.terminate();
      } else {
        client.ping();
      }
    }
  }

  /** Re-resolves every connected session once; skips a tick while one runs. */
  async revalidate(): Promise<void> {
    if (this.revalidating) return;
    this.revalidating = true;
    try {
      for (const [sessionId, clients] of this.connections.sessions()) {
        await this.revalidateSession(sessionId, clients);
      }
    } finally {
      this.revalidating = false;
    }
  }

  private async revalidateSession(
    sessionId: string,
    clients: LiveClient[],
  ): Promise<void> {
    try {
      const auth = await this.sessions.resolve(clients[0].sessionToken);
      if (!auth || auth.sessionId !== sessionId) {
        this.connections.endSession(sessionId);
        return;
      }
      for (const client of clients) {
        client.user = auth.user;
        for (const topic of [...client.topics]) {
          const decision = await this.authorizers.decide(auth.user, topic);
          if (decision === 'allowed') continue;
          this.connections.unsubscribe(client, topic);
          client.send({ type: 'error', topic, code: decision });
        }
      }
    } catch (error) {
      // A database hiccup is not a reason to drop anyone; the next tick retries.
      this.logger.error(
        `live re-validation of a session failed: ${(error as Error).message}`,
      );
    }
  }
}
