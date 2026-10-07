import {
  LIVE_CLOSE_CODES,
  type LiveClientMessage,
  type LiveEventMessage,
  type LiveTopic,
  liveServerMessageSchema,
} from '@agentdock/shared';

/** What the status dot shows: connected, trying again, or given up. */
export type LiveStatus = 'connected' | 'reconnecting' | 'offline';

export interface LiveSnapshot {
  status: LiveStatus;
  /** The close code that made the client give up; set only while `offline`. */
  closeCode: number | null;
}

export type LiveHandler = (message: LiveEventMessage) => void;

/** The slice of `WebSocket` the client uses; a test passes a fake. */
export interface LiveSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface LiveClientOptions {
  url: string;
  createSocket: (url: string) => LiveSocket;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
/** Below the server's 75 s idle limit (spec D13) with room for a lost frame. */
export const PING_INTERVAL_MS = 25_000;

/** Closes after which retrying cannot help; the user must act (spec W3). */
const FATAL_CLOSE_CODES: readonly number[] = [
  LIVE_CLOSE_CODES.unauthorized,
  LIVE_CLOSE_CODES.forbiddenOrigin,
  LIVE_CLOSE_CODES.tooManyConnections,
];

/** Reconnect delay for the nth consecutive failure: 1 s doubling to 30 s, ±20 % jitter. */
export function backoffDelay(attempt: number, random: () => number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
  return Math.min(BACKOFF_MAX_MS, Math.round(base * (0.8 + random() * 0.4)));
}

/**
 * One WebSocket shared by every `useLive` in the tab (spec D15). It connects
 * while at least one topic is wanted, resubscribes after a reconnect, and
 * gives up on the close codes where retrying would only repeat the refusal.
 */
export class LiveClient {
  private readonly handlers = new Map<LiveTopic, Set<LiveHandler>>();
  private readonly listeners = new Set<() => void>();
  private readonly random: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (id: unknown) => void;
  private socket: LiveSocket | null = null;
  private open = false;
  private attempt = 0;
  private retryTimer: unknown = null;
  private pingTimer: unknown = null;
  private snapshot: LiveSnapshot = { status: 'reconnecting', closeCode: null };

  constructor(private readonly options: LiveClientOptions) {
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimer ??
      ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  }

  getSnapshot = (): LiveSnapshot => this.snapshot;

  /** For `useSyncExternalStore`. */
  onChange = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribe(topic: LiveTopic, handler: LiveHandler): () => void {
    let set = this.handlers.get(topic);
    const first = !set;
    if (!set) {
      set = new Set();
      this.handlers.set(topic, set);
    }
    set.add(handler);

    if (first) this.send({ type: 'subscribe', topic });
    this.ensureConnected();

    return () => {
      const current = this.handlers.get(topic);
      if (!current?.delete(handler)) return;
      if (current.size > 0) return;
      this.handlers.delete(topic);
      this.send({ type: 'unsubscribe', topic });
      if (this.handlers.size === 0) this.disconnect();
    };
  }

  private ensureConnected() {
    if (this.socket || this.retryTimer !== null) return;
    if (this.snapshot.status === 'offline') return;
    this.connect();
  }

  private connect() {
    const socket = this.options.createSocket(this.options.url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.open = true;
      this.attempt = 0;
      this.setSnapshot({ status: 'connected', closeCode: null });
      for (const topic of this.handlers.keys()) {
        this.send({ type: 'subscribe', topic });
      }
      this.pingTimer = this.setTimer(this.ping, PING_INTERVAL_MS);
    };
    socket.onmessage = (event) => {
      if (this.socket === socket) this.receive(event.data);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.open = false;
      this.stopPing();
      if (FATAL_CLOSE_CODES.includes(event.code)) {
        this.setSnapshot({ status: 'offline', closeCode: event.code });
        return;
      }
      this.setSnapshot({ status: 'reconnecting', closeCode: null });
      if (this.handlers.size === 0) return;
      const delay = backoffDelay(this.attempt, this.random);
      this.attempt += 1;
      this.retryTimer = this.setTimer(() => {
        this.retryTimer = null;
        if (this.handlers.size > 0) this.connect();
      }, delay);
    };
  }

  private disconnect() {
    if (this.retryTimer !== null) this.clearTimer(this.retryTimer);
    this.retryTimer = null;
    this.stopPing();
    const socket = this.socket;
    this.socket = null;
    this.open = false;
    this.attempt = 0;
    socket?.close();
    this.setSnapshot({ status: 'reconnecting', closeCode: null });
  }

  private readonly ping = () => {
    this.send({ type: 'ping' });
    this.pingTimer = this.setTimer(this.ping, PING_INTERVAL_MS);
  };

  private stopPing() {
    if (this.pingTimer !== null) this.clearTimer(this.pingTimer);
    this.pingTimer = null;
  }

  private send(message: LiveClientMessage) {
    if (this.open) this.socket?.send(JSON.stringify(message));
  }

  private receive(raw: unknown) {
    if (typeof raw !== 'string') return;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = liveServerMessageSchema.safeParse(json);
    if (!parsed.success || parsed.data.type !== 'event') return;
    const message = parsed.data;
    for (const handler of this.handlers.get(message.topic) ?? []) {
      handler(message);
    }
  }

  private setSnapshot(next: LiveSnapshot) {
    if (
      next.status === this.snapshot.status &&
      next.closeCode === this.snapshot.closeCode
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

const DEFAULT_LIVE_URL = 'ws://localhost:8180/live';

let shared: LiveClient | null = null;

/** The tab's client; browser only. */
export function getLiveClient(): LiveClient {
  shared ??= new LiveClient({
    url: process.env.NEXT_PUBLIC_LIVE_URL ?? DEFAULT_LIVE_URL,
    createSocket: (url) => new WebSocket(url) as unknown as LiveSocket,
  });
  return shared;
}
