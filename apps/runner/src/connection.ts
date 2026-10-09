import {
  type HeartbeatMessage,
  type HelloMessage,
  MAX_EVENTS_BATCH_BYTES,
  MAX_EVENTS_PER_BATCH,
  RUNNER_CLOSE_CODES,
  type RunnerEvent,
  type RunnerMessage,
  type RunnerServerConfig,
  type ServerMessage,
  type SubscribeMessage,
  serverMessageSchema,
  type TerminalCloseMessage,
  type TerminalDataMessage,
  type TerminalResizeMessage,
  type UnsequencedEvent,
} from '@agentdock/shared/protocol';
import type { Backoff } from './backoff';
import { type Cancel, type Clock, isoNow } from './clock';
import type { Dispatch } from './commands/dispatcher';
import { errorMessage, type Logger } from './log';
import { socketUrl } from './server-url';
import type { Spool } from './spool';

export const HEARTBEAT_INTERVAL_MS = 15_000;
/** A connection that lasted this long resets the backoff (D6). */
export const BACKOFF_RESET_AFTER_MS = 60_000;

/** Close codes after which reconnecting can only loop: the daemon stops. */
const TERMINAL_CLOSE_CODES: ReadonlySet<number> = new Set(
  Object.values(RUNNER_CLOSE_CODES),
);

/** The part of `hello` the daemon supplies; `type` and `lastAckedSeq` are added here. */
export type HelloPayload = Omit<HelloMessage, 'type' | 'id' | 'lastAckedSeq'>;
export type HeartbeatPayload = Omit<HeartbeatMessage, 'type' | 'id' | 'ts'>;

export type SocketFactory = (url: string, token: string) => WebSocket;

export const bunSocketFactory: SocketFactory = (url, token) =>
  new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });

export type StopReason =
  | { kind: 'stopped' }
  | { kind: 'terminal'; code: number; reason: string };

export interface ConnectionOptions {
  server: string;
  token: string;
  spool: Spool;
  clock: Clock;
  backoff: Backoff;
  log: Logger;
  hello: () => Promise<HelloPayload>;
  heartbeat: () => Promise<HeartbeatPayload>;
  dispatch: Dispatch;
  /** The server's config, from `welcome` on every connect and from `config` after. */
  onConfig?: (config: RunnerServerConfig) => void;
  /** Live pane subscriptions (spec 18); without it they are ignored. */
  pane?: PaneHandler;
  /** Interactive attach streams (spec 29); without it they are ignored. */
  terminal?: TerminalHandler;
  createSocket?: SocketFactory;
  heartbeatMs?: number;
}

/** What the connection hands pane `subscribe` / `unsubscribe` to. */
export interface PaneHandler {
  subscribe(message: SubscribeMessage): Promise<void>;
  unsubscribe(id: string): void;
  /** The socket closed: subscriptions die with it, the server resubscribes. */
  reset(): void;
}

/** What the connection hands the `terminal.*` stream messages to. */
export interface TerminalHandler {
  data(message: TerminalDataMessage): void;
  resize(message: TerminalResizeMessage): void;
  close(message: TerminalCloseMessage): void;
  /** The socket closed: every attach ends with it (spec 29 D7). */
  reset(): void;
}

type State = 'idle' | 'connecting' | 'open' | 'live' | 'stopped';

/** Splits events into `events` messages within the protocol's count and size limits. */
export function* batches(
  events: Iterable<RunnerEvent>,
): Generator<RunnerEvent[]> {
  let batch: RunnerEvent[] = [];
  let bytes = 64;
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event)) + 1;
    if (
      batch.length > 0 &&
      (batch.length >= MAX_EVENTS_PER_BATCH ||
        bytes + size > MAX_EVENTS_BATCH_BYTES)
    ) {
      yield batch;
      batch = [];
      bytes = 64;
    }
    batch.push(event);
    bytes += size;
  }
  if (batch.length > 0) yield batch;
}

/**
 * The runner's one outbound socket (runner-protocol.md): `hello` on open,
 * resend above `welcome.ackedSeq`, heartbeats while live, commands dispatched,
 * reconnect with backoff — until stopped or closed with a terminal code.
 */
export class RunnerConnection {
  private state: State = 'idle';
  private socket: WebSocket | null = null;
  private openedAt: number | null = null;
  /** Highest seq sent on the current connection. */
  private sentSeq = 0;
  private cancelHeartbeat: Cancel = () => {};
  private cancelReconnect: Cancel = () => {};
  private resolveDone: (reason: StopReason) => void = () => {};
  readonly done: Promise<StopReason>;
  private readonly url: string;
  private readonly createSocket: SocketFactory;

  constructor(private readonly options: ConnectionOptions) {
    this.url = socketUrl(options.server);
    this.createSocket = options.createSocket ?? bunSocketFactory;
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  get isLive(): boolean {
    return this.state === 'live';
  }

  start(): void {
    if (this.state !== 'idle') return;
    this.connect();
  }

  /** Closes the socket and stops reconnecting. */
  stop(): void {
    if (this.state === 'stopped') return;
    this.finish({ kind: 'stopped' });
  }

  /** Spools an event and, when live, sends it right away. */
  emit(event: UnsequencedEvent): RunnerEvent[] {
    const appended = this.options.spool.append(event);
    if (this.state === 'live') this.flush();
    return appended;
  }

  private connect(): void {
    const { log } = this.options;
    this.state = 'connecting';
    log.info('connecting', { url: this.url });
    let socket: WebSocket;
    try {
      socket = this.createSocket(this.url, this.options.token);
    } catch (error) {
      log.warn('cannot open the socket', { error: errorMessage(error) });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.state = 'open';
      this.openedAt = this.options.clock.now();
      void this.sendHello(socket);
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.receive(event.data);
    };
    socket.onerror = () => {
      log.debug('socket error');
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.closed(event.code, event.reason);
    };
  }

  private async sendHello(socket: WebSocket): Promise<void> {
    try {
      const hello = await this.options.hello();
      if (this.socket !== socket) return;
      this.send({
        type: 'hello',
        ...hello,
        lastAckedSeq: this.options.spool.ackedSeq,
      });
    } catch (error) {
      this.options.log.error('cannot build hello', {
        error: errorMessage(error),
      });
      socket.close(1011, 'hello failed');
    }
  }

  private receive(data: unknown): void {
    const { log } = this.options;
    let json: unknown;
    try {
      json = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      log.warn('ignored a message that is not JSON');
      return;
    }
    const parsed = serverMessageSchema.safeParse(json);
    if (!parsed.success) {
      const type = (json as { type?: unknown } | null)?.type;
      log.warn('ignored an invalid server message', {
        type: typeof type === 'string' ? type : null,
      });
      return;
    }
    this.handle(parsed.data);
  }

  private handle(message: ServerMessage): void {
    const { spool, log } = this.options;
    switch (message.type) {
      case 'welcome': {
        log.info('connected', {
          runnerId: message.runnerId,
          ackedSeq: message.ackedSeq,
        });
        spool.ack(message.ackedSeq);
        this.sentSeq = message.ackedSeq;
        this.state = 'live';
        this.flush();
        this.startHeartbeat();
        this.options.onConfig?.(message.config);
        return;
      }
      case 'config':
        log.info('config updated', {
          projects: message.config.projects.length,
        });
        this.options.onConfig?.(message.config);
        return;
      case 'ack':
        spool.ack(message.seq);
        return;
      case 'command':
        void this.options.dispatch(message).then((result) => this.send(result));
        return;
      case 'subscribe':
        if (message.kind === 'pane') void this.options.pane?.subscribe(message);
        return;
      case 'unsubscribe':
        this.options.pane?.unsubscribe(message.id);
        return;
      case 'terminal.data':
        this.options.terminal?.data(message);
        return;
      case 'terminal.resize':
        this.options.terminal?.resize(message);
        return;
      case 'terminal.close':
        this.options.terminal?.close(message);
        return;
    }
  }

  /** Sends every spooled event above what this connection already sent. */
  private flush(): void {
    for (const batch of batches(this.options.spool.eventsAfter(this.sentSeq))) {
      if (!this.send({ type: 'events', events: batch })) return;
      this.sentSeq = batch[batch.length - 1].seq;
    }
  }

  private startHeartbeat(): void {
    this.cancelHeartbeat();
    this.cancelHeartbeat = this.options.clock.setInterval(() => {
      void this.beat();
    }, this.options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS);
  }

  private async beat(): Promise<void> {
    try {
      const payload = await this.options.heartbeat();
      if (this.state !== 'live') return;
      this.send({
        type: 'heartbeat',
        ts: isoNow(this.options.clock),
        ...payload,
      });
    } catch (error) {
      this.options.log.warn('heartbeat failed', { error: errorMessage(error) });
    }
  }

  /** Sends a message when the socket is open; pane frames and terminal bytes use it. */
  sendMessage(message: RunnerMessage): boolean {
    return this.send(message);
  }

  private send(message: RunnerMessage): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  private closed(code: number, reason: string): void {
    const { log, clock, backoff } = this.options;
    this.cancelHeartbeat();
    this.socket = null;
    this.options.pane?.reset();
    this.options.terminal?.reset();
    if (this.state === 'stopped') return;
    if (TERMINAL_CLOSE_CODES.has(code)) {
      log.error('the server closed the connection for good', { code, reason });
      this.finish({ kind: 'terminal', code, reason });
      return;
    }
    if (
      this.openedAt !== null &&
      clock.now() - this.openedAt >= BACKOFF_RESET_AFTER_MS
    ) {
      backoff.reset();
    }
    this.openedAt = null;
    log.warn('disconnected', { code, reason });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.state = 'idle';
    const delay = this.options.backoff.next();
    this.options.log.info('reconnecting', { inMs: delay });
    this.cancelReconnect = this.options.clock.setTimeout(() => {
      if (this.state === 'idle') this.connect();
    }, delay);
  }

  private finish(reason: StopReason): void {
    this.state = 'stopped';
    this.cancelHeartbeat();
    this.cancelReconnect();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState <= WebSocket.OPEN)
      socket.close(1000, 'runner stopping');
    this.resolveDone(reason);
  }
}
