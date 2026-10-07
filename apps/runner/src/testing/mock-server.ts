import {
  PAIRING_PATH,
  RUNNER_SOCKET_PATH,
  type RunnerMessage,
  runnerMessageSchema,
  type ServerMessage,
} from '@agentdock/shared/protocol';
import type { Server, ServerWebSocket } from 'bun';

interface SocketData {
  authorization: string | null;
}

export type PairingHandler = (body: unknown) => Response;

/**
 * A stand-in for the AgentDock API (#6 is not built yet): the pairing
 * endpoint and the `/runner` socket. Every message the runner sends is parsed
 * with the protocol schema, so a malformed one fails the test.
 */
export class MockServer {
  readonly received: RunnerMessage[] = [];
  readonly invalid: unknown[] = [];
  readonly authorizations: (string | null)[] = [];
  readonly pairingBodies: unknown[] = [];
  connections = 0;
  pairing: PairingHandler = () =>
    Response.json({ error: 'invalid_code' }, { status: 400 });
  /** Sent on every new socket once `hello` arrives; null sends nothing. */
  welcome: ((hello: RunnerMessage) => ServerMessage | null) | null = null;

  private server: Server<SocketData> | null = null;
  private socket: ServerWebSocket<SocketData> | null = null;

  constructor(private port = 0) {}

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  start(): this {
    this.server = Bun.serve<SocketData>({
      port: this.port,
      hostname: '127.0.0.1',
      fetch: async (request, server) => {
        const url = new URL(request.url);
        if (url.pathname === RUNNER_SOCKET_PATH) {
          const authorization = request.headers.get('authorization');
          if (server.upgrade(request, { data: { authorization } }))
            return undefined;
          return new Response('upgrade failed', { status: 400 });
        }
        if (url.pathname === PAIRING_PATH && request.method === 'POST') {
          const body: unknown = await request.json();
          this.pairingBodies.push(body);
          return this.pairing(body);
        }
        return new Response('not found', { status: 404 });
      },
      websocket: {
        open: (ws) => {
          this.connections++;
          this.authorizations.push(ws.data.authorization);
          this.socket = ws;
        },
        message: (ws, raw) => {
          const parsed = runnerMessageSchema.safeParse(JSON.parse(String(raw)));
          if (!parsed.success) {
            this.invalid.push(raw);
            return;
          }
          this.received.push(parsed.data);
          if (parsed.data.type === 'hello' && this.welcome) {
            const reply = this.welcome(parsed.data);
            if (reply) ws.send(JSON.stringify(reply));
          }
        },
        close: (ws) => {
          if (this.socket === ws) this.socket = null;
        },
      },
    });
    this.port = this.server.port ?? this.port;
    return this;
  }

  /** Drops every connection and stops listening; `start()` again reuses the port. */
  stop(): void {
    this.server?.stop(true);
    this.server = null;
    this.socket = null;
  }

  send(message: ServerMessage | Record<string, unknown>): void {
    if (!this.socket) throw new Error('no runner connected');
    this.socket.send(JSON.stringify(message));
  }

  close(code: number, reason = ''): void {
    this.socket?.close(code, reason);
  }

  get connected(): boolean {
    return this.socket !== null;
  }

  of<T extends RunnerMessage['type']>(
    type: T,
  ): Extract<RunnerMessage, { type: T }>[] {
    return this.received.filter(
      (m): m is Extract<RunnerMessage, { type: T }> => m.type === type,
    );
  }

  /** Resolves once `count` messages of `type` have arrived in total. */
  async waitFor<T extends RunnerMessage['type']>(
    type: T,
    count = 1,
    timeoutMs = 3_000,
  ): Promise<Extract<RunnerMessage, { type: T }>[]> {
    await until(
      () => this.of(type).length >= count,
      timeoutMs,
      `${count} × ${type}`,
    );
    return this.of(type);
  }
}

/** Polls `condition` on real time — for socket I/O, which no fake clock drives. */
export const until = async (
  condition: () => boolean,
  timeoutMs = 3_000,
  what = 'condition',
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};
