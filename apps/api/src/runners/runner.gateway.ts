import type { IncomingMessage } from 'node:http';
import {
  MAX_EVENTS_BATCH_BYTES,
  PROTOCOL_VERSION,
  RUNNER_CLOSE_CODES,
  RUNNER_SOCKET_PATH,
  type RunnerMessage,
  runnerMessageSchema,
} from '@agentdock/shared/protocol';
import { Inject, Logger } from '@nestjs/common';
import { type OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import type { RawData, WebSocket } from 'ws';
import { bearerToken } from './credentials';
import { LiveConnection, RunnerConnections } from './runner-connections';
import { RunnerIngestService } from './runner-ingest.service';
import { RUNNER_OPTIONS, type RunnerOptions } from './runner-options';
import { RunnerStreams } from './runner-streams';
import { RunnerWatchList } from './runner-watch-list';

/** Standard close codes the gateway uses besides `RUNNER_CLOSE_CODES`. */
const POLICY_VIOLATION = 1008;
const INTERNAL_ERROR = 1011;

interface Deps {
  ingest: RunnerIngestService;
  connections: RunnerConnections;
  watchList: RunnerWatchList;
  streams: RunnerStreams;
  options: RunnerOptions;
  logger: Logger;
}

/**
 * One runner socket, from upgrade to close. Frames are handled strictly in
 * order — including those that arrive while the token is being verified — so
 * an `ack` never overtakes the batch it acknowledges.
 */
class RunnerSocket {
  private queue: Promise<void> = Promise.resolve();
  private runnerId: string | null = null;
  private live: LiveConnection | null = null;
  private closed = false;
  private readonly helloTimer: NodeJS.Timeout;

  constructor(
    private readonly socket: WebSocket,
    request: IncomingMessage,
    private readonly deps: Deps,
  ) {
    socket.on('message', (data) => this.enqueue(() => this.receive(data)));
    socket.on('close', () => this.onClose());
    this.helloTimer = setTimeout(
      () => this.close(POLICY_VIOLATION, 'hello expected'),
      deps.options.helloTimeoutMs,
    );
    this.helloTimer.unref();
    const token = bearerToken(request.headers.authorization);
    this.enqueue(() => this.authenticate(token));
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(async () => {
      if (this.closed) return;
      try {
        await task();
      } catch (error) {
        this.deps.logger.error(
          `runner ${this.runnerId ?? '?'}: ${(error as Error).message}`,
        );
        this.close(INTERNAL_ERROR, 'internal error');
      }
    });
  }

  private async authenticate(token: string | null): Promise<void> {
    const runner = token ? await this.deps.ingest.authenticate(token) : null;
    if (!runner) {
      this.deps.logger.warn('runner socket refused: missing or invalid token');
      this.close(RUNNER_CLOSE_CODES.unauthorized, 'unauthorized');
      return;
    }
    this.runnerId = runner.id;
  }

  private async receive(data: RawData): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(data.toString());
    } catch {
      this.deps.logger.warn(`runner ${this.runnerId}: frame is not JSON`);
      return;
    }
    const type = (json as { type?: unknown } | null)?.type;
    const version = (json as { protocolVersion?: unknown } | null)
      ?.protocolVersion;
    // Checked before the schema: another version's hello may not parse at all.
    if (type === 'hello' && version !== PROTOCOL_VERSION) {
      this.close(
        RUNNER_CLOSE_CODES.protocolMismatch,
        `supported protocol version: ${PROTOCOL_VERSION}`,
      );
      return;
    }
    const parsed = runnerMessageSchema.safeParse(json);
    if (!parsed.success) {
      // Never the payload: it may carry anything the runner read.
      this.deps.logger.warn(
        `runner ${this.runnerId}: invalid ${typeof type === 'string' ? type : 'untyped'} message dropped`,
      );
      if (!this.live) this.close(POLICY_VIOLATION, 'hello expected');
      return;
    }
    await this.handle(parsed.data);
  }

  private async handle(message: RunnerMessage): Promise<void> {
    const runnerId = this.runnerId;
    if (runnerId === null) return;
    const live = this.live;
    if (!live) {
      if (message.type !== 'hello') {
        this.close(POLICY_VIOLATION, 'hello expected');
        return;
      }
      await this.hello(runnerId, message);
      return;
    }
    switch (message.type) {
      case 'hello':
        this.deps.logger.warn(`runner ${runnerId}: repeated hello ignored`);
        return;
      case 'heartbeat':
        live.lastBeatAt = Date.now();
        live.heartbeat = {
          receivedAt: new Date(live.lastBeatAt).toISOString(),
          load: message.load,
          tmuxSessions: message.tmuxSessions,
          collectors: message.collectors,
        };
        await this.deps.ingest.heartbeat(runnerId);
        return;
      case 'events': {
        const acked = await this.deps.ingest.events(runnerId, message.events);
        live.send({ type: 'ack', seq: Number(acked) });
        return;
      }
      case 'command.result':
        if (!live.settle(message)) {
          this.deps.logger.debug(
            `runner ${runnerId}: result for a command nobody awaits`,
          );
        }
        return;
      case 'command.progress':
        // Streaming command output lands with the item that uses it.
        return;
      case 'pane':
      case 'subscribe.error':
        this.deps.streams.deliver(runnerId, message);
        return;
      case 'terminal.data':
      case 'terminal.close':
        this.deps.streams.deliverTerminal(runnerId, message);
        return;
    }
  }

  private async hello(
    runnerId: string,
    hello: Extract<RunnerMessage, { type: 'hello' }>,
  ): Promise<void> {
    const acked = await this.deps.ingest.hello(runnerId, hello);
    if (acked === null || this.closed) {
      this.close(RUNNER_CLOSE_CODES.unauthorized, 'unauthorized');
      return;
    }
    clearTimeout(this.helloTimer);
    const live = new LiveConnection(runnerId, this.socket, Date.now());
    this.live = live;
    // Attached and welcomed in one step, queued with the watch-list pushes:
    // a project connected meanwhile is either in this list or pushed as
    // `config` right after the welcome (spec 10 D9).
    await this.deps.watchList.deliver(runnerId, (config) => {
      if (this.closed) return;
      this.deps.connections.attach(live);
      live.send({ type: 'welcome', runnerId, config, ackedSeq: Number(acked) });
    });
    if (this.closed) return;
    // After the welcome: a `subscribe` sent from here is the runner's first.
    this.deps.streams.connected(live);
    this.deps.logger.log(`runner ${runnerId} connected`);
  }

  private close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.helloTimer);
    if (this.live) this.detach(this.live);
    if (this.socket.readyState <= this.socket.OPEN) {
      this.socket.close(code, reason);
    }
  }

  private onClose(): void {
    const wasLive = this.live !== null;
    this.closed = true;
    clearTimeout(this.helloTimer);
    if (this.live) this.detach(this.live);
    if (wasLive) this.deps.logger.log(`runner ${this.runnerId} disconnected`);
  }

  /** Both close paths may run; the second finds nothing left to do. */
  private detach(live: LiveConnection): void {
    this.deps.connections.detach(live);
    this.deps.streams.disconnected(live);
  }
}

/**
 * `/runner` (runner-protocol.md, spec D3–D7). Frames are `{ type, … }`, not
 * Nest's `{ event, data }`, so each socket is handled by hand rather than by
 * `@SubscribeMessage` — which also keeps the HTTP guards off this path; the
 * runner token is the only credential here.
 */
@WebSocketGateway({
  path: RUNNER_SOCKET_PATH,
  // A batch is ≤ 256 KiB; leave room for framing, refuse anything larger.
  maxPayload: MAX_EVENTS_BATCH_BYTES * 2,
})
export class RunnerGateway implements OnGatewayConnection {
  private readonly logger = new Logger(RunnerGateway.name);

  constructor(
    private readonly ingest: RunnerIngestService,
    private readonly connections: RunnerConnections,
    private readonly watchList: RunnerWatchList,
    private readonly streams: RunnerStreams,
    @Inject(RUNNER_OPTIONS) private readonly options: RunnerOptions,
  ) {}

  handleConnection(socket: WebSocket, request: IncomingMessage): void {
    new RunnerSocket(socket, request, {
      ingest: this.ingest,
      connections: this.connections,
      watchList: this.watchList,
      streams: this.streams,
      options: this.options,
      logger: this.logger,
    });
  }
}
