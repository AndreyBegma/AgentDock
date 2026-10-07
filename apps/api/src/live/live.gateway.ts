import type { IncomingMessage } from 'node:http';
import {
  LIVE_CLOSE_CODES,
  LIVE_SOCKET_PATH,
  type LiveClientMessage,
  type LiveTopic,
  liveClientMessageSchema,
  MAX_LIVE_MESSAGE_BYTES,
  MAX_LIVE_SUBSCRIPTIONS,
  SESSION_COOKIE,
} from '@agentdock/shared';
import { Logger } from '@nestjs/common';
import { type OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import type { RawData, WebSocket } from 'ws';
import { SessionService } from '../auth';
import { cookieFrom, originAllowed } from './handshake';
import { LiveClient, LiveConnections } from './live-connections';
import { allowedLiveOrigin } from './live-options';
import { TopicAuthorizerRegistry } from './topic-authorizer.registry';

const INTERNAL_ERROR = 1011;

interface Deps {
  sessions: SessionService;
  connections: LiveConnections;
  authorizers: TopicAuthorizerRegistry;
  logger: Logger;
}

/**
 * One `/live` socket, from upgrade to close. Frames are handled in order —
 * those that arrive while the session is being resolved wait for it — so a
 * refused socket never gets an answer to anything it sent.
 */
class LiveSocket {
  private queue: Promise<void> = Promise.resolve();
  private client: LiveClient | null = null;
  private closed = false;

  constructor(
    private readonly socket: WebSocket,
    request: IncomingMessage,
    private readonly deps: Deps,
  ) {
    socket.on('message', (data) => this.enqueue(() => this.receive(data)));
    socket.on('pong', () => this.seen());
    socket.on('close', () => this.onClose());

    // Cross-site WebSocket hijacking guard: a browser always sends Origin,
    // and CSRF tokens do not apply to an upgrade (spec D10).
    if (!originAllowed(request.headers.origin, allowedLiveOrigin())) {
      this.close(LIVE_CLOSE_CODES.forbiddenOrigin, 'origin not allowed');
      return;
    }
    const token = cookieFrom(request.headers.cookie, SESSION_COOKIE);
    this.enqueue(() => this.authenticate(token));
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(async () => {
      if (this.closed) return;
      try {
        await task();
      } catch (error) {
        this.deps.logger.error(`live socket: ${(error as Error).message}`);
        this.close(INTERNAL_ERROR, 'internal error');
      }
    });
  }

  private seen(): void {
    if (this.client) this.client.lastSeenAt = Date.now();
  }

  private async authenticate(token: string | null): Promise<void> {
    const auth = token ? await this.deps.sessions.resolve(token) : null;
    if (!auth || !token) {
      this.close(LIVE_CLOSE_CODES.unauthorized, 'unauthorized');
      return;
    }
    if (this.closed) return;
    const client = new LiveClient(
      this.socket,
      auth.sessionId,
      token,
      auth.user,
      Date.now(),
    );
    if (!this.deps.connections.add(client)) {
      this.close(LIVE_CLOSE_CODES.tooManyConnections, 'too many connections');
      return;
    }
    this.client = client;
  }

  private async receive(data: RawData): Promise<void> {
    const client = this.client;
    if (!client) return;
    client.lastSeenAt = Date.now();
    let json: unknown;
    try {
      json = JSON.parse(data.toString());
    } catch {
      client.send({ type: 'error', code: 'invalid_message' });
      return;
    }
    const parsed = liveClientMessageSchema.safeParse(json);
    if (!parsed.success) {
      client.send({ type: 'error', code: 'invalid_message' });
      return;
    }
    await this.handle(client, parsed.data);
  }

  private async handle(
    client: LiveClient,
    message: LiveClientMessage,
  ): Promise<void> {
    switch (message.type) {
      case 'ping':
        client.send({ type: 'pong' });
        return;
      case 'unsubscribe':
        this.deps.connections.unsubscribe(client, message.topic);
        return;
      case 'subscribe':
        await this.subscribe(client, message.topic);
        return;
    }
  }

  private async subscribe(client: LiveClient, topic: LiveTopic): Promise<void> {
    if (client.topics.has(topic)) {
      client.send({ type: 'subscribed', topic });
      return;
    }
    if (client.topics.size >= MAX_LIVE_SUBSCRIPTIONS) {
      client.send({ type: 'error', topic, code: 'too_many_subscriptions' });
      return;
    }
    const decision = await this.deps.authorizers.decide(client.user, topic);
    if (decision !== 'allowed') {
      client.send({ type: 'error', topic, code: decision });
      return;
    }
    if (this.closed) return;
    this.deps.connections.subscribe(client, topic);
    client.send({ type: 'subscribed', topic });
  }

  private close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.client) this.deps.connections.remove(this.client);
    if (this.socket.readyState <= this.socket.OPEN) {
      this.socket.close(code, reason);
    }
  }

  private onClose(): void {
    this.closed = true;
    if (this.client) this.deps.connections.remove(this.client);
  }
}

/**
 * `/live` (spec D9–D13): typed live updates for the web app. Frames are
 * `{ type, … }`, so each socket is handled by hand like `/runner` — which also
 * keeps the HTTP guards off this path; the session cookie and the origin are
 * checked here instead.
 */
@WebSocketGateway({
  path: LIVE_SOCKET_PATH,
  // Larger frames are refused by `ws` itself (close 1009).
  maxPayload: MAX_LIVE_MESSAGE_BYTES,
})
export class LiveGateway implements OnGatewayConnection {
  private readonly logger = new Logger(LiveGateway.name);

  constructor(
    private readonly sessions: SessionService,
    private readonly connections: LiveConnections,
    private readonly authorizers: TopicAuthorizerRegistry,
  ) {}

  handleConnection(socket: WebSocket, request: IncomingMessage): void {
    new LiveSocket(socket, request, {
      sessions: this.sessions,
      connections: this.connections,
      authorizers: this.authorizers,
      logger: this.logger,
    });
  }
}
