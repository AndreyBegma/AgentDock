import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Socket, UnixSocketListener } from 'bun';
import { errorMessage, type Logger } from '../log';
import {
  LOCAL_LINE_MAX_BYTES,
  type LocalOp,
  type LocalReply,
  type LocalResult,
  localLineSchema,
} from './types';

export type LocalHandler = (
  op: LocalOp,
  args: unknown,
) => Promise<LocalResult<unknown>>;

export interface LocalSocketServerOptions {
  path: string;
  handle: LocalHandler;
  log: Logger;
}

interface Connection {
  /** Bytes received after the last newline. */
  pending: Buffer;
  /** Bytes not yet written, kept until `drain`. */
  outbound: Buffer;
  closed: boolean;
}

const NEWLINE = 0x0a;

/**
 * The daemon's unix socket (spec 201 D5). Created after `runner.lock` is
 * held, so a socket file already there is a dead daemon's and is unlinked.
 * The directory is 0700 and the socket 0600: file permissions are the only
 * peer authentication, as for `runner.json`.
 */
export class LocalSocketServer {
  private listener: UnixSocketListener<Connection> | null = null;

  constructor(private readonly options: LocalSocketServerOptions) {}

  get path(): string {
    return this.options.path;
  }

  /** Binds the socket. Throws when it cannot — the caller decides what then. */
  start(): void {
    const { path } = this.options;
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    if (existsSync(path)) rmSync(path, { force: true });
    this.listener = Bun.listen<Connection>({
      unix: path,
      socket: {
        open: (socket) => {
          socket.data = {
            pending: Buffer.alloc(0),
            outbound: Buffer.alloc(0),
            closed: false,
          };
        },
        data: (socket, chunk) => this.receive(socket, chunk),
        drain: (socket) => this.flush(socket),
        close: (socket) => {
          socket.data.closed = true;
        },
        error: (socket, error) => {
          socket.data.closed = true;
          this.options.log.debug('local: socket error', {
            error: errorMessage(error),
          });
        },
      },
    });
    chmodSync(path, 0o600);
  }

  stop(): void {
    const listener = this.listener;
    this.listener = null;
    listener?.stop(true);
    rmSync(this.options.path, { force: true });
  }

  private receive(socket: Socket<Connection>, chunk: Buffer): void {
    const state = socket.data;
    let buffer =
      state.pending.length > 0 ? Buffer.concat([state.pending, chunk]) : chunk;
    for (;;) {
      const end = buffer.indexOf(NEWLINE);
      if (end < 0) break;
      const line = buffer.subarray(0, end);
      buffer = buffer.subarray(end + 1);
      if (line.length > LOCAL_LINE_MAX_BYTES) {
        this.reject(socket, 'line over 256 KiB');
        return;
      }
      if (line.length > 0) void this.line(socket, line.toString('utf8'));
    }
    if (buffer.length > LOCAL_LINE_MAX_BYTES) {
      this.reject(socket, 'line over 256 KiB');
      return;
    }
    state.pending = Buffer.from(buffer);
  }

  /** A framing error: answered without an id, and the connection closed. */
  private reject(socket: Socket<Connection>, message: string): void {
    this.write(socket, {
      ok: false,
      error: { code: 'invalid_args', message },
    });
    socket.data.pending = Buffer.alloc(0);
    socket.end();
  }

  private async line(socket: Socket<Connection>, text: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      this.write(socket, {
        ok: false,
        error: { code: 'invalid_args', message: 'not JSON' },
      });
      return;
    }
    const parsed = localLineSchema.safeParse(json);
    if (!parsed.success) {
      const id = (json as { id?: unknown } | null)?.id;
      this.write(socket, {
        ...(typeof id === 'string' ? { id } : {}),
        ok: false,
        error: { code: 'invalid_args', message: 'expected {id, op, args}' },
      });
      return;
    }
    const { id, op, args } = parsed.data;
    const result = await this.options.handle(op, args);
    this.write(
      socket,
      result.ok
        ? { id, ok: true, data: result.data }
        : { id, ok: false, error: result.error },
    );
  }

  private write(socket: Socket<Connection>, reply: LocalReply): void {
    const state = socket.data;
    if (state.closed) return;
    const bytes = Buffer.from(`${JSON.stringify(reply)}\n`, 'utf8');
    state.outbound =
      state.outbound.length > 0
        ? Buffer.concat([state.outbound, bytes])
        : bytes;
    this.flush(socket);
  }

  private flush(socket: Socket<Connection>): void {
    const state = socket.data;
    if (state.closed || state.outbound.length === 0) return;
    const written = socket.write(state.outbound);
    state.outbound =
      written >= state.outbound.length
        ? Buffer.alloc(0)
        : Buffer.from(state.outbound.subarray(Math.max(0, written)));
  }
}
