/**
 * The client side of the daemon's local socket (docs/specs/201-claude-code-integration.md
 * D5, D6). Hook, `away` and MCP processes use it; none of them talks to the
 * server or holds the runner token.
 *
 * ```ts
 * const client = await connectLocal(socketPath);       // null when the daemon is down
 * if (!client) return;                                  // within LOCAL_CONNECT_TIMEOUT_MS (300 ms)
 * const r = await client.request('queue.list', { limit: 10 }, {
 *   via: 'mcp', cwd: env.CLAUDE_PROJECT_DIR, ppid: process.ppid,
 * });
 * if (r.ok) r.data.items;                               // typed by `localMethods[...].result`
 * else r.error.code;                                    // LocalErrorCode: 'runner_offline', 'no_project', …
 * client.close();
 * ```
 *
 * - `connectLocal(path, { timeoutMs? })` → `LocalClient | null`.
 * - `client.request(method, args, ctx)` → `LocalResult<LocalMethodResult<method>>`.
 *   `ctx` is `{ via: 'mcp'|'hook'|'cli', cwd?, ppid?, sessionId? }`: the daemon
 *   correlates `cwd` to the project (D9) and `sessionId`, else `ppid`, else
 *   the single live session in `cwd`, to the session (D10). The result is
 *   checked against the method's result schema; a mismatch is `internal`.
 * - `client.event(args)` → a hook event for the spool (`LocalEventArgs`).
 * - `client.ping({ cwd? })` → `{ pong, online, awayMode, projectId }`.
 * - Every call resolves, never throws. A lost daemon is `daemon_unavailable`;
 *   no answer within `LOCAL_REQUEST_TIMEOUT_MS` + 1 s is `timeout`.
 * - `localRequest(path, method, args, ctx)` is the one-shot form: connect,
 *   ask, close.
 */
import {
  LOCAL_REQUEST_TIMEOUT_MS,
  type LocalMethodName,
  type LocalMethodResult,
  localMethods,
} from '@agentdock/shared/protocol';
import type { Socket } from 'bun';
import type { z } from 'zod';
import {
  LOCAL_CONNECT_TIMEOUT_MS,
  LOCAL_LINE_MAX_BYTES,
  type LocalEventArgs,
  type LocalOp,
  type LocalPingResult,
  type LocalResult,
  type LocalVia,
  localFail,
  localPingResultSchema,
  localReplySchema,
} from './types';

/** A method's args as the caller writes them: defaults may be left out. */
export type LocalMethodInput<N extends LocalMethodName> = z.input<
  (typeof localMethods)[N]['args']
>;

export interface LocalRequestContext {
  via: LocalVia;
  cwd?: string;
  ppid?: number;
  sessionId?: string;
}

export interface ConnectOptions {
  timeoutMs?: number;
  /** Per call; the daemon's own relay deadline plus a margin by default. */
  callTimeoutMs?: number;
}

const UNAVAILABLE = localFail(
  'daemon_unavailable',
  'the runner daemon is not running',
);

interface ClientState {
  pending: Buffer;
}

type Settle = (result: LocalResult<unknown>) => void;

export class LocalClient {
  private nextId = 1;
  private readonly waiting = new Map<string, Settle>();
  private closed = false;

  /** @internal Built by `connectLocal`. */
  constructor(
    private readonly socket: Socket<ClientState>,
    private readonly callTimeoutMs: number,
  ) {}

  request<N extends LocalMethodName>(
    method: N,
    args: LocalMethodInput<N>,
    context: LocalRequestContext,
  ): Promise<LocalResult<LocalMethodResult<N>>> {
    return this.call('request', { method, args, ...context }).then((result) => {
      if (!result.ok) return result;
      const parsed = localMethods[method].result.safeParse(result.data);
      return parsed.success
        ? { ok: true, data: parsed.data as LocalMethodResult<N> }
        : localFail('internal', `unexpected ${method} result`);
    });
  }

  event(args: LocalEventArgs): Promise<LocalResult<unknown>> {
    return this.call('event', args);
  }

  ping(args: { cwd?: string } = {}): Promise<LocalResult<LocalPingResult>> {
    return this.call('ping', args).then((result) => {
      if (!result.ok) return result;
      const parsed = localPingResultSchema.safeParse(result.data);
      return parsed.success
        ? { ok: true, data: parsed.data }
        : localFail('internal', 'unexpected ping result');
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.end();
    this.lost();
  }

  /** @internal */
  receive(chunk: Buffer): void {
    const state = this.socket.data;
    let buffer =
      state.pending.length > 0 ? Buffer.concat([state.pending, chunk]) : chunk;
    for (;;) {
      const end = buffer.indexOf(0x0a);
      if (end < 0) break;
      this.reply(buffer.subarray(0, end).toString('utf8'));
      buffer = buffer.subarray(end + 1);
    }
    state.pending = Buffer.from(buffer);
  }

  /** @internal The socket closed: every open call is `daemon_unavailable`. */
  lost(): void {
    this.closed = true;
    const waiting = [...this.waiting.values()];
    this.waiting.clear();
    for (const settle of waiting) settle(UNAVAILABLE);
  }

  private reply(text: string): void {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = localReplySchema.safeParse(json);
    if (!parsed.success || parsed.data.id === undefined) return;
    const settle = this.waiting.get(parsed.data.id);
    if (!settle) return;
    this.waiting.delete(parsed.data.id);
    settle(
      parsed.data.ok
        ? { ok: true, data: parsed.data.data }
        : { ok: false, error: parsed.data.error ?? { code: 'internal' } },
    );
  }

  private call(op: LocalOp, args: unknown): Promise<LocalResult<unknown>> {
    if (this.closed) return Promise.resolve(UNAVAILABLE);
    const id = `l${this.nextId++}`;
    const line = `${JSON.stringify({ id, op, args })}\n`;
    if (Buffer.byteLength(line) > LOCAL_LINE_MAX_BYTES) {
      return Promise.resolve(localFail('invalid_args', 'line over 256 KiB'));
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiting.delete(id)) resolve(localFail('timeout'));
      }, this.callTimeoutMs);
      this.waiting.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      this.writeAll(Buffer.from(line, 'utf8'));
    });
  }

  private outbound: Buffer = Buffer.alloc(0);

  private writeAll(bytes: Buffer): void {
    this.outbound =
      this.outbound.length > 0 ? Buffer.concat([this.outbound, bytes]) : bytes;
    this.drain();
  }

  /** @internal */
  drain(): void {
    if (this.closed || this.outbound.length === 0) return;
    const written = this.socket.write(this.outbound);
    this.outbound =
      written >= this.outbound.length
        ? Buffer.alloc(0)
        : Buffer.from(this.outbound.subarray(Math.max(0, written)));
  }
}

/** Connects to the daemon; null when it is not there within `timeoutMs`. */
export const connectLocal = async (
  path: string,
  options: ConnectOptions = {},
): Promise<LocalClient | null> => {
  const timeoutMs = options.timeoutMs ?? LOCAL_CONNECT_TIMEOUT_MS;
  const callTimeoutMs =
    options.callTimeoutMs ?? LOCAL_REQUEST_TIMEOUT_MS + 1_000;
  let client: LocalClient | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connecting = Bun.connect<ClientState>({
    unix: path,
    socket: {
      open: (socket) => {
        socket.data = { pending: Buffer.alloc(0) };
      },
      data: (_socket, chunk) => client?.receive(chunk),
      drain: () => client?.drain(),
      close: () => client?.lost(),
      error: () => client?.lost(),
      connectError: () => {},
    },
  })
    .then((socket) => socket)
    .catch(() => null);
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const socket = await Promise.race([connecting, timedOut]);
  clearTimeout(timer);
  if (!socket) {
    // A connect that lands after the deadline is closed, not leaked.
    void connecting.then((late) => late?.end());
    return null;
  }
  client = new LocalClient(socket, callTimeoutMs);
  return client;
};

/** Connect, ask once, close. `daemon_unavailable` when the daemon is down. */
export const localRequest = async <N extends LocalMethodName>(
  path: string,
  method: N,
  args: LocalMethodInput<N>,
  context: LocalRequestContext,
  options: ConnectOptions = {},
): Promise<LocalResult<LocalMethodResult<N>>> => {
  const client = await connectLocal(path, options);
  if (!client) return UNAVAILABLE;
  try {
    return await client.request(method, args, context);
  } finally {
    client.close();
  }
};
