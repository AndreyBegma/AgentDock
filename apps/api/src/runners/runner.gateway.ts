import type { IncomingMessage } from 'node:http';
import {
  type CommandResultMessage,
  MAX_EVENTS_BATCH_BYTES,
  PROTOCOL_VERSION,
  RUNNER_CLOSE_CODES,
  RUNNER_SOCKET_PATH,
  type RunnerMessage,
  runnerCommandsOf,
  runnerMessageSchema,
  SERVER_FEATURES,
} from '@nautelle/shared/protocol';
import { Inject, Logger } from '@nestjs/common';
import { type OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import type { RawData, WebSocket } from 'ws';
import { clientIp } from '../common/client-ip';
import { bearerToken } from './credentials';
import { commandResultOf } from './runner-command-result';
import { RunnerConnectHooks } from './runner-connect-hooks';
import {
  LiveConnection,
  RunnerConnections,
  type RunnerPeer,
} from './runner-connections';
import { RunnerIngestService } from './runner-ingest.service';
import { RunnerLocalRequests } from './runner-local-requests';
import { RUNNER_OPTIONS, type RunnerOptions } from './runner-options';
import { RunnerReplacements } from './runner-replacements';
import { RunnerStreams } from './runner-streams';
import { RunnerWatchList } from './runner-watch-list';

/** Standard close codes the gateway uses besides `RUNNER_CLOSE_CODES`. */
const PROTOCOL_ERROR = 1002;
const POLICY_VIOLATION = 1008;
const INTERNAL_ERROR = 1011;

/** Bytes of a raw frame, whatever shape `ws` hands over. */
const byteLength = (data: RawData): number =>
  Array.isArray(data)
    ? data.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    : data.byteLength;

/** As the terminal gateway reads it: the client IP and its user agent. */
const peerOf = (request: IncomingMessage): RunnerPeer => ({
  ip: clientIp(request) ?? null,
  userAgent: request.headers['user-agent'] ?? null,
});

interface Deps {
  ingest: RunnerIngestService;
  connections: RunnerConnections;
  watchList: RunnerWatchList;
  streams: RunnerStreams;
  localRequests: RunnerLocalRequests;
  connectHooks: RunnerConnectHooks;
  replacements: RunnerReplacements;
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
  /** The hash the token was verified against; `hello` must still match it. */
  private tokenHash: string | null = null;
  /** Leaves the pre-hello registry (C-118); a no-op once left. */
  private release: () => void = () => {};
  private live: LiveConnection | null = null;
  private closed = false;
  private readonly helloTimer: NodeJS.Timeout;
  private readonly peer: RunnerPeer;

  constructor(
    private readonly socket: WebSocket,
    request: IncomingMessage,
    private readonly deps: Deps,
  ) {
    this.peer = peerOf(request);
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
    this.tokenHash = runner.tokenHash;
    // Until hello completes, re-pairing or revoking must still reach it.
    this.release = this.deps.connections.admit(runner.id, (code, reason) =>
      this.close(code, reason),
    );
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
    // C-137: `maxPayload` leaves room for other frames; a batch is held to
    // its own cap on the raw frame, before the schema walks it.
    if (type === 'events' && byteLength(data) > MAX_EVENTS_BATCH_BYTES) {
      this.deps.logger.warn(
        `runner ${this.runnerId}: events frame over ${MAX_EVENTS_BATCH_BYTES} bytes refused`,
      );
      this.close(PROTOCOL_ERROR, 'events batch too large');
      return;
    }
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
    const tokenHash = this.tokenHash;
    if (runnerId === null || tokenHash === null) return;
    const live = this.live;
    if (!live) {
      if (message.type !== 'hello') {
        this.close(POLICY_VIOLATION, 'hello expected');
        return;
      }
      await this.hello(runnerId, tokenHash, message);
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
        await this.deps.ingest.heartbeat(runnerId, message.profiles);
        return;
      case 'events': {
        // #740 D1: results first — ingest strips their output before storing.
        for (const event of message.events) {
          const result = commandResultOf(event);
          if (result) this.result(runnerId, result);
        }
        const acked = await this.deps.ingest.events(runnerId, message.events);
        live.send({ type: 'ack', seq: Number(acked) });
        return;
      }
      case 'command.result':
        // A runner that has not seen `command_results_spooled` (#740 D6).
        this.result(runnerId, message);
        return;
      case 'command.progress':
        // Streaming command output lands with the item that uses it.
        return;
      case 'pane':
      case 'run_log':
      case 'subscribe.error':
        this.deps.streams.deliver(runnerId, message);
        return;
      case 'terminal.data':
      case 'terminal.close':
      case 'terminal.history':
        this.deps.streams.deliverTerminal(runnerId, message);
        return;
      case 'local.request':
        this.local(runnerId, live, message);
        return;
    }
  }

  /**
   * Settles the waiter of a `command.result`, whichever socket of the runner
   * carried it (#740 D2). A resend of a settled one is expected (D3); one
   * nobody awaits — its caller gave up, or it never was — is logged and
   * emits nothing (D4).
   */
  private result(runnerId: string, message: CommandResultMessage): void {
    const { outcome, name } = this.deps.connections.settle(runnerId, message);
    const what = `${name ?? 'unknown command'} ${message.id} (ok: ${message.ok})`;
    if (outcome === 'repeat') {
      this.deps.logger.debug(`runner ${runnerId}: repeated result of ${what}`);
    } else if (outcome === 'unawaited') {
      this.deps.logger.warn(
        `runner ${runnerId}: result of ${what} arrived with nobody awaiting it`,
      );
    }
  }

  /**
   * Answered off the frame queue (spec 201 D6): a handler may send the runner
   * a command — `issue.create` for `create_issue` — whose `command.result`
   * arrives on this same queue, so awaiting it here would deadlock.
   */
  private local(
    runnerId: string,
    live: LiveConnection,
    request: Extract<RunnerMessage, { type: 'local.request' }>,
  ): void {
    void this.deps.localRequests.answer(runnerId, request).then((response) => {
      if (!live.send(response)) {
        this.deps.logger.debug(
          `runner ${runnerId}: local.response ${request.id} not sent, socket gone`,
        );
      }
    });
  }

  private async hello(
    runnerId: string,
    tokenHash: string,
    hello: Extract<RunnerMessage, { type: 'hello' }>,
  ): Promise<void> {
    const acked = await this.deps.ingest.hello(runnerId, tokenHash, hello);
    if (acked === null || this.closed) {
      this.close(RUNNER_CLOSE_CODES.unauthorized, 'unauthorized');
      return;
    }
    clearTimeout(this.helloTimer);
    const live = new LiveConnection(
      runnerId,
      this.socket,
      Date.now(),
      runnerCommandsOf(hello.capabilities),
      this.peer,
    );
    this.live = live;
    let replaced: LiveConnection | null = null;
    // Attached and welcomed in one step, queued with the watch-list pushes:
    // a project connected meanwhile is either in this list or pushed as
    // `config` right after the welcome (spec 10 D9).
    await this.deps.watchList.deliver(runnerId, (config) => {
      if (this.closed) return;
      this.release();
      replaced = this.deps.connections.attach(live);
      live.send({
        type: 'welcome',
        runnerId,
        config,
        ackedSeq: Number(acked),
        features: [SERVER_FEATURES.commandResultsSpooled],
      });
    });
    if (this.closed) return;
    // After the welcome: a `subscribe` sent from here is the runner's first.
    this.deps.streams.connected(live);
    this.deps.logger.log(`runner ${runnerId} connected`);
    // Off the frame queue (#329 D4): a hook may send a command, whose result
    // arrives on this same queue.
    void this.deps.connectHooks.connected(runnerId);
    // C-108: a live socket taken over — audited and told to admins, off the
    // frame queue like the hooks.
    const previous = replaced as LiveConnection | null;
    if (previous) {
      void this.deps.replacements.replaced({
        runnerId,
        previous: {
          ...previous.peer,
          connectedAt: new Date(previous.connectedAt),
        },
        next: this.peer,
        at: new Date(live.connectedAt),
      });
    }
  }

  private close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.helloTimer);
    this.release();
    if (this.live) this.detach(this.live);
    if (this.socket.readyState <= this.socket.OPEN) {
      this.socket.close(code, reason);
    }
  }

  private onClose(): void {
    const wasLive = this.live !== null;
    this.closed = true;
    clearTimeout(this.helloTimer);
    this.release();
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
    private readonly localRequests: RunnerLocalRequests,
    private readonly connectHooks: RunnerConnectHooks,
    private readonly replacements: RunnerReplacements,
    @Inject(RUNNER_OPTIONS) private readonly options: RunnerOptions,
  ) {}

  handleConnection(socket: WebSocket, request: IncomingMessage): void {
    new RunnerSocket(socket, request, {
      ingest: this.ingest,
      connections: this.connections,
      watchList: this.watchList,
      streams: this.streams,
      localRequests: this.localRequests,
      connectHooks: this.connectHooks,
      replacements: this.replacements,
      options: this.options,
      logger: this.logger,
    });
  }
}
