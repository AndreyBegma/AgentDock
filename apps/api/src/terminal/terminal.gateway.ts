import type { IncomingMessage } from 'node:http';
import {
  SESSION_COOKIE,
  TERMINAL_CLOSE_CODES,
  TERMINAL_DEFAULT_SIZE,
  TERMINAL_WS_QUERY,
  type TerminalServerFrame,
} from '@agentdock/shared';
import {
  TERMINAL_MAX_DATA_BYTES,
  TERMINAL_WS_PATH,
  terminalClientFrameSchema,
  terminalColsSchema,
  terminalRowsSchema,
} from '@agentdock/shared/protocol';
import { Logger } from '@nestjs/common';
import { type OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import { type RawData, WebSocket } from 'ws';
import type { RequestOrigin } from '../audit/audit.types';
import { SessionService } from '../auth';
import { cookieFrom, originAllowed } from '../live/handshake';
import { allowedLiveOrigin } from '../live/live-options';
import { ProjectAccessService } from '../projects';
import {
  type TerminalAttach,
  type TerminalBrowser,
  TerminalRelay,
} from './terminal-relay';
import { TerminalTickets } from './terminal-tickets';

const POLICY_VIOLATION = 1008;
const INTERNAL_ERROR = 1011;
/** Room for a text frame next to the largest binary one. */
const MAX_FRAME_BYTES = TERMINAL_MAX_DATA_BYTES + 1024;

interface Deps {
  sessions: SessionService;
  tickets: TerminalTickets;
  access: ProjectAccessService;
  relay: TerminalRelay;
  logger: Logger;
}

/** A PTY size from the upgrade query, else the default. */
const sizeFrom = (params: URLSearchParams) => {
  const cols = terminalColsSchema.safeParse(
    Number(params.get(TERMINAL_WS_QUERY.cols)),
  );
  const rows = terminalRowsSchema.safeParse(
    Number(params.get(TERMINAL_WS_QUERY.rows)),
  );
  return {
    cols: cols.success ? cols.data : TERMINAL_DEFAULT_SIZE.cols,
    rows: rows.success ? rows.data : TERMINAL_DEFAULT_SIZE.rows,
  };
};

const originOf = (request: IncomingMessage): RequestOrigin => ({
  ip: request.socket.remoteAddress,
  userAgent: request.headers['user-agent'],
});

/**
 * One `/terminal` socket, from upgrade to close (spec 29 D5, D6). Frames are
 * handled in order — those that arrive while the upgrade is checked wait for
 * it, and are dropped if it is refused.
 */
class TerminalSocket implements TerminalBrowser {
  private queue: Promise<void> = Promise.resolve();
  private attach: TerminalAttach | null = null;
  private closed = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly request: IncomingMessage,
    private readonly deps: Deps,
  ) {
    socket.on('message', (data, isBinary) =>
      this.enqueue(async () => this.receive(data, isBinary)),
    );
    socket.on('close', () => this.onClose());

    // Cross-site WebSocket hijacking guard: a browser always sends Origin (D5).
    if (!originAllowed(request.headers.origin, allowedLiveOrigin())) {
      this.close(TERMINAL_CLOSE_CODES.forbiddenOrigin, 'origin not allowed');
      return;
    }
    this.enqueue(() => this.authenticate());
  }

  // TerminalBrowser

  sendData(bytes: Buffer): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(bytes, { binary: true });
    }
  }

  sendFrame(frame: TerminalServerFrame): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
    }
  }

  close(code: number, reason: string): void {
    this.closed = true;
    if (this.socket.readyState <= WebSocket.OPEN) {
      this.socket.close(code, reason);
    }
  }

  // Upgrade

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(async () => {
      if (this.closed) return;
      try {
        await task();
      } catch (error) {
        this.deps.logger.error(`terminal socket: ${(error as Error).message}`);
        this.close(INTERNAL_ERROR, 'internal error');
      }
    });
  }

  /**
   * D5, in order: a valid session cookie; the ticket, consumed whatever comes
   * next; the ticket's session is this cookie's; the user is still an admin;
   * the project is still visible.
   */
  private async authenticate(): Promise<void> {
    const { sessions, tickets, access, relay } = this.deps;
    const token = cookieFrom(this.request.headers.cookie, SESSION_COOKIE);
    const auth = token ? await sessions.resolve(token) : null;
    if (!auth || !token) {
      this.close(TERMINAL_CLOSE_CODES.unauthorized, 'unauthorized');
      return;
    }
    const params = new URL(this.request.url ?? '/', 'http://localhost')
      .searchParams;
    const ticket = params.get(TERMINAL_WS_QUERY.ticket);
    const grant = ticket ? tickets.consume(ticket) : null;
    if (
      !grant ||
      grant.userId !== auth.user.id ||
      grant.sessionId !== auth.sessionId
    ) {
      this.close(TERMINAL_CLOSE_CODES.invalidTicket, 'invalid ticket');
      return;
    }
    if (auth.user.role !== 'admin') {
      this.close(TERMINAL_CLOSE_CODES.forbidden, 'forbidden');
      return;
    }
    if (!(await access.resolve(auth.user, grant.target.projectId))) {
      this.close(TERMINAL_CLOSE_CODES.notFound, 'not_found');
      return;
    }
    if (this.closed) return;
    this.attach = relay.open({
      grant,
      user: { id: auth.user.id, email: auth.user.email },
      sessionToken: token,
      origin: originOf(this.request),
      ...sizeFrom(params),
      browser: this,
    });
  }

  // Frames

  private receive(data: RawData, isBinary: boolean): void {
    const attach = this.attach;
    if (!attach) return;
    if (isBinary) {
      this.deps.relay.input(attach, toBuffer(data));
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(data.toString());
    } catch {
      json = null;
    }
    const parsed = terminalClientFrameSchema.safeParse(json);
    if (!parsed.success) {
      // The socket's close ends the attach as `client`.
      this.close(POLICY_VIOLATION, 'invalid frame');
      return;
    }
    if (parsed.data.type === 'close') {
      void this.deps.relay.detach(attach);
      return;
    }
    this.deps.relay.resize(attach, parsed.data.cols, parsed.data.rows);
  }

  private onClose(): void {
    this.closed = true;
    if (this.attach) void this.deps.relay.detach(this.attach);
  }
}

const toBuffer = (data: RawData): Buffer => {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
};

/**
 * `/terminal` (spec 29 D5): the browser end of an interactive attach.
 * Separate from `/live` — bidirectional, binary, and opened with a one-time
 * ticket on top of the session cookie and the `Origin` check. Handled by hand
 * like `/live`, so the HTTP guards stay off this path.
 */
@WebSocketGateway({ path: TERMINAL_WS_PATH, maxPayload: MAX_FRAME_BYTES })
export class TerminalGateway implements OnGatewayConnection {
  private readonly logger = new Logger(TerminalGateway.name);

  constructor(
    private readonly sessions: SessionService,
    private readonly tickets: TerminalTickets,
    private readonly access: ProjectAccessService,
    private readonly relay: TerminalRelay,
  ) {}

  handleConnection(socket: WebSocket, request: IncomingMessage): void {
    new TerminalSocket(socket, request, {
      sessions: this.sessions,
      tickets: this.tickets,
      access: this.access,
      relay: this.relay,
      logger: this.logger,
    });
  }
}
