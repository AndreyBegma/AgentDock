import { randomUUID } from 'node:crypto';
import {
  TERMINAL_CLOSE_CODES,
  type TerminalAttachView,
  type TerminalRefusalCode,
  type TerminalServerFrame,
} from '@agentdock/shared';
import {
  type CommandErrorCode,
  TERMINAL_MAX_DATA_BYTES,
  type TerminalCloseReason,
  type TerminalMode,
  type TerminalTarget,
} from '@agentdock/shared/protocol';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { type RequestOrigin, userActor } from '../audit/audit.types';
import { SessionService } from '../auth';
import type {
  RunnerStreamListener,
  RunnerStreamMessage,
} from '../runners/runner-streams';
import { TERMINAL_OPTIONS, type TerminalOptions } from './terminal-options';
import {
  TERMINAL_RUNNER_PORT,
  type TerminalAttachOutcome,
  type TerminalFromRunner,
  type TerminalRunnerPort,
} from './terminal-runner-port';
import type { TerminalGrant } from './terminal-tickets';

/** The browser end of an attach: the `/terminal` socket. */
export interface TerminalBrowser {
  /** Terminal output, one binary frame. */
  sendData(bytes: Buffer): void;
  sendFrame(frame: TerminalServerFrame): void;
  close(code: number, reason: string): void;
}

export interface TerminalUser {
  id: string;
  email: string;
}

/** Everything the gateway checked before it asks for an attach. */
export interface AttachRequest {
  grant: TerminalGrant;
  user: TerminalUser;
  /** The session cookie it upgraded with — what revalidation resolves again. */
  sessionToken: string;
  origin: RequestOrigin;
  cols: number;
  rows: number;
  browser: TerminalBrowser;
}

type AttachState = 'attaching' | 'open' | 'closed';

/** One live attach (D9): kept in memory only, history is the audit log. */
export class TerminalAttach {
  state: AttachState = 'attaching';
  session: string | null = null;
  /** Input bytes forwarded to the runner (write attaches only). */
  bytesIn = 0;
  /** Output bytes relayed to the browser. */
  bytesOut = 0;
  /** Input bytes dropped: a read attach's, or sent before the runner attached. */
  droppedIn = 0;
  lastInputAt: number;
  lastTrafficAt: number;
  endReason: TerminalCloseReason | null = null;
  endCause: string | null = null;
  idleTimer: NodeJS.Timeout | null = null;
  maxTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly id: string,
    readonly grant: TerminalGrant,
    readonly user: TerminalUser,
    readonly sessionToken: string,
    readonly origin: RequestOrigin,
    readonly browser: TerminalBrowser,
    readonly since: number,
  ) {
    this.lastInputAt = since;
    this.lastTrafficAt = since;
  }

  get mode(): TerminalMode {
    return this.grant.mode;
  }

  get target(): TerminalTarget {
    return this.grant.target;
  }

  get runnerId(): string {
    return this.grant.runnerId;
  }
}

/** One target, whatever its kind: what "one read-write attach per target" counts (D7). */
export const targetKey = (target: TerminalTarget): string => {
  switch (target.kind) {
    case 'slot':
      return `${target.projectId}:slot:${target.slot}`;
    case 'orchestrator':
      return `${target.projectId}:orchestrator`;
    case 'skill_run':
      return `${target.projectId}:skill_run:${target.runId}`;
  }
};

/** How a runner's refusal reaches the browser: the close code and the `error` frame's code. */
const refusal = (
  code: CommandErrorCode,
): { close: number; code: TerminalRefusalCode } => {
  switch (code) {
    case 'not_found':
      return { close: TERMINAL_CLOSE_CODES.notFound, code: 'not_found' };
    case 'busy':
      return { close: TERMINAL_CLOSE_CODES.busy, code: 'busy' };
    case 'unsupported':
      return { close: TERMINAL_CLOSE_CODES.unsupported, code: 'unsupported' };
    case 'disabled':
      return { close: TERMINAL_CLOSE_CODES.unsupported, code: 'disabled' };
    default:
      return {
        close: TERMINAL_CLOSE_CODES.runnerUnavailable,
        code: 'runner_unavailable',
      };
  }
};

const auditTarget = (target: TerminalTarget) => {
  switch (target.kind) {
    case 'slot':
      return { type: 'slot', id: target.slot };
    case 'orchestrator':
      return { type: 'orchestrator', id: target.projectId };
    case 'skill_run':
      return { type: 'skill_run', id: target.runId };
  }
};

/** The target as the audit record and the active list show it — no root path. */
const targetView = (target: TerminalTarget) => ({
  kind: target.kind,
  projectId: target.projectId,
  slot: target.kind === 'slot' ? target.slot : null,
  runId: target.kind === 'skill_run' ? target.runId : null,
});

/**
 * The relay between `/terminal` sockets and runners (spec 29 D5–D9). Opens an
 * attach with `terminal.attach`, then moves bytes both ways and enforces the
 * limits: input of a `read` attach never leaves the API (D6, defence in depth
 * with the runner), one `write` attach per target, idle and maximum duration
 * (D7). Every attach that the runner opened is audited when it opens and when
 * it ends, with byte counts — never the bytes (D8). Logs carry ids and counts.
 */
@Injectable()
export class TerminalRelay
  implements RunnerStreamListener, OnModuleInit, OnModuleDestroy
{
  readonly name = 'terminal';
  private readonly logger = new Logger(TerminalRelay.name);
  private readonly attaches = new Map<string, TerminalAttach>();
  private revalidateTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(TERMINAL_RUNNER_PORT) private readonly runner: TerminalRunnerPort,
    @Inject(AuditService)
    private readonly audit: Pick<AuditService, 'record'>,
    @Inject(SessionService)
    private readonly sessions: Pick<SessionService, 'resolve'>,
    @Inject(TERMINAL_OPTIONS) private readonly options: TerminalOptions,
  ) {}

  onModuleInit(): void {
    this.revalidateTimer = setInterval(
      () => void this.revalidate(),
      this.options.revalidateMs,
    );
    this.revalidateTimer.unref();
  }

  /** The API is going down: every attach ends with `socket`, and is audited. */
  async onModuleDestroy(): Promise<void> {
    if (this.revalidateTimer) clearInterval(this.revalidateTimer);
    await Promise.all(
      [...this.attaches.values()].map((a) => this.end(a, 'socket')),
    );
  }

  // Reads

  /** Who holds the read-write attach of `target`, if anyone (D7). */
  writeHolder(target: TerminalTarget): TerminalUser | null {
    const key = targetKey(target);
    for (const a of this.attaches.values()) {
      if (a.mode === 'write' && targetKey(a.target) === key) return a.user;
    }
    return null;
  }

  /** The project's live attaches, oldest first (D9). */
  active(projectId: string): TerminalAttachView[] {
    return [...this.attaches.values()]
      .filter((a) => a.target.projectId === projectId)
      .map((a) => ({
        id: a.id,
        target: targetView(a.target),
        mode: a.mode,
        user: { ...a.user },
        since: new Date(a.since).toISOString(),
      }));
  }

  // Browser side

  /**
   * Starts an attach for a socket that passed every check. Returns its handle
   * at once — input that arrives while the runner attaches is dropped — or
   * null when it was refused, the browser socket already told why.
   */
  open(request: AttachRequest): TerminalAttach | null {
    const { grant, browser } = request;
    if (grant.mode === 'write') {
      const holder = this.writeHolder(grant.target);
      if (holder) {
        browser.sendFrame({ type: 'error', code: 'busy', heldBy: holder });
        browser.close(TERMINAL_CLOSE_CODES.busy, 'busy');
        void this.record(request, 'terminal.attached', 'denied', {
          after: { target: targetView(grant.target), mode: grant.mode },
          // Not `code`: the audit log redacts that key (pairing codes).
          meta: { ticketId: grant.ticketId, refusal: 'busy' },
        });
        return null;
      }
    }
    const attach = new TerminalAttach(
      `term_${randomUUID()}`,
      grant,
      request.user,
      request.sessionToken,
      request.origin,
      browser,
      Date.now(),
    );
    this.attaches.set(attach.id, attach);
    attach.maxTimer = setTimeout(
      () => void this.end(attach, 'max_duration'),
      this.options.maxDurationMs,
    );
    attach.maxTimer.unref();
    this.armIdle(attach, this.options.idleTimeoutMs);
    void this.connect(attach, request.cols, request.rows).catch((error) =>
      this.logger.error(
        `terminal ${attach.id}: attach failed: ${(error as Error).message}`,
      ),
    );
    return attach;
  }

  /** A binary frame from the browser: input for the PTY. */
  input(attach: TerminalAttach, bytes: Buffer): void {
    if (attach.state === 'closed') return;
    attach.lastTrafficAt = Date.now();
    // Read-only: dropped here and by the runner (D6). Before the runner
    // attached there is nowhere to send it.
    if (attach.mode !== 'write' || attach.state !== 'open') {
      attach.droppedIn += bytes.length;
      return;
    }
    attach.lastInputAt = attach.lastTrafficAt;
    for (
      let offset = 0;
      offset < bytes.length;
      offset += TERMINAL_MAX_DATA_BYTES
    ) {
      const chunk = bytes.subarray(offset, offset + TERMINAL_MAX_DATA_BYTES);
      const sent = this.runner.send(attach.runnerId, {
        type: 'terminal.data',
        id: attach.id,
        b64: chunk.toString('base64'),
      });
      if (!sent) {
        void this.end(attach, 'socket');
        return;
      }
      attach.bytesIn += chunk.length;
    }
  }

  resize(attach: TerminalAttach, cols: number, rows: number): void {
    if (attach.state !== 'open') return;
    attach.lastTrafficAt = Date.now();
    this.runner.send(attach.runnerId, {
      type: 'terminal.resize',
      id: attach.id,
      cols,
      rows,
    });
  }

  /** The admin detached (`{ type: 'close' }`) or the browser socket closed. */
  detach(attach: TerminalAttach): Promise<void> {
    return this.end(attach, 'client');
  }

  // Runner side

  /** A `terminal.data` or `terminal.close` from a runner. */
  fromRunner(runnerId: string, message: TerminalFromRunner): void {
    const attach = this.attaches.get(message.id);
    // A runner feeds only its own attaches; a late message of an ended one is dropped.
    if (!attach || attach.runnerId !== runnerId) {
      this.logger.debug(`runner ${runnerId}: terminal message for no attach`);
      return;
    }
    if (message.type === 'terminal.close') {
      void this.end(attach, message.reason, { notifyRunner: false });
      return;
    }
    const bytes = Buffer.from(message.b64, 'base64');
    attach.bytesOut += bytes.length;
    attach.lastTrafficAt = Date.now();
    attach.browser.sendData(bytes);
  }

  // RunnerStreamListener: an attach does not survive the runner's socket.

  connected(runnerId: string): void {
    this.dropRunner(runnerId);
  }

  disconnected(runnerId: string): void {
    this.dropRunner(runnerId);
  }

  message(_runnerId: string, _message: RunnerStreamMessage): void {
    // Pane frames; not ours.
  }

  terminal(runnerId: string, message: TerminalFromRunner): void {
    this.fromRunner(runnerId, message);
  }

  /**
   * Ends every attach whose session is gone or whose user is no longer an
   * admin (D1). Runs every `revalidateMs`; exposed for tests.
   */
  async revalidate(): Promise<void> {
    for (const attach of [...this.attaches.values()]) {
      const auth = await this.sessions.resolve(attach.sessionToken);
      if (auth && auth.user.id === attach.user.id && auth.user.role === 'admin')
        continue;
      await this.end(attach, 'client', { cause: 'session_revoked' });
    }
  }

  // Lifecycle

  private async connect(
    attach: TerminalAttach,
    cols: number,
    rows: number,
  ): Promise<void> {
    const { grant } = attach;
    const outcome: TerminalAttachOutcome = await this.runner.attach(
      attach.runnerId,
      { id: attach.id, target: grant.target, mode: grant.mode, cols, rows },
      { ctx: { actor: userActor(attach.user.id), origin: attach.origin } },
    );
    if (outcome.status !== 'ok') {
      await this.refused(attach, outcome);
      return;
    }
    attach.session = outcome.session;
    await this.record(attach, 'terminal.attached', 'ok', {
      after: {
        target: targetView(grant.target),
        mode: grant.mode,
        session: outcome.session,
      },
      meta: { ticketId: grant.ticketId, streamId: attach.id },
    });
    if (attach.state === 'closed') {
      // The browser left while the runner attached: undo it on the runner.
      this.runner.send(attach.runnerId, {
        type: 'terminal.close',
        id: attach.id,
        reason: attach.endReason ?? 'client',
      });
      await this.recordDetached(attach);
      return;
    }
    attach.state = 'open';
    attach.browser.sendFrame({
      type: 'attached',
      id: attach.id,
      mode: grant.mode,
      session: outcome.session,
    });
    this.logger.log(
      `terminal ${attach.id} attached: ${grant.mode} ${grant.target.kind} on runner ${attach.runnerId}`,
    );
  }

  private async refused(
    attach: TerminalAttach,
    outcome: Exclude<TerminalAttachOutcome, { status: 'ok' }>,
  ): Promise<void> {
    const code = outcome.status === 'error' ? outcome.code : 'unknown';
    if (outcome.status === 'unknown') {
      // No answer: it may still attach late; make sure it lets go.
      this.runner.send(attach.runnerId, {
        type: 'terminal.close',
        id: attach.id,
        reason: 'client',
      });
    }
    const wasOpen = attach.state !== 'closed';
    this.forget(attach);
    if (wasOpen) {
      const mapped =
        outcome.status === 'error'
          ? refusal(outcome.code)
          : {
              close: TERMINAL_CLOSE_CODES.runnerUnavailable,
              code: 'runner_unavailable' as const,
            };
      attach.browser.sendFrame({
        type: 'error',
        code: mapped.code,
        ...(outcome.status === 'error' && outcome.message
          ? { message: outcome.message }
          : {}),
      });
      attach.browser.close(mapped.close, mapped.code);
    }
    this.logger.log(`terminal ${attach.id} refused: ${code}`);
    await this.record(attach, 'terminal.attached', 'error', {
      after: { target: targetView(attach.target), mode: attach.mode },
      meta: {
        ticketId: attach.grant.ticketId,
        streamId: attach.id,
        refusal: code,
      },
    });
  }

  /**
   * Ends an attach once: tells the runner (unless it is the one that ended
   * it), closes the browser socket, audits. One that the runner has not
   * attached yet is finished by `connect` when its answer arrives.
   */
  private async end(
    attach: TerminalAttach,
    reason: TerminalCloseReason,
    {
      notifyRunner = true,
      cause,
    }: { notifyRunner?: boolean; cause?: string } = {},
  ): Promise<void> {
    if (attach.state === 'closed') return;
    const wasOpen = attach.state === 'open';
    attach.endReason = reason;
    attach.endCause = cause ?? null;
    this.forget(attach);
    if (wasOpen && notifyRunner) {
      this.runner.send(attach.runnerId, {
        type: 'terminal.close',
        id: attach.id,
        reason,
      });
    }
    attach.browser.sendFrame({ type: 'closed', reason });
    attach.browser.close(TERMINAL_CLOSE_CODES.ended, reason);
    if (wasOpen) await this.recordDetached(attach);
  }

  private forget(attach: TerminalAttach): void {
    attach.state = 'closed';
    if (attach.idleTimer) clearTimeout(attach.idleTimer);
    if (attach.maxTimer) clearTimeout(attach.maxTimer);
    attach.idleTimer = null;
    attach.maxTimer = null;
    this.attaches.delete(attach.id);
  }

  private dropRunner(runnerId: string): void {
    for (const attach of [...this.attaches.values()]) {
      if (attach.runnerId === runnerId) {
        void this.end(attach, 'socket', { notifyRunner: false });
      }
    }
  }

  /**
   * Idle is no input bytes on a `write` attach, and no traffic either way on
   * a `read` one (D7). The timer fires at the earliest possible deadline and
   * re-arms itself while there was activity.
   */
  private armIdle(attach: TerminalAttach, delayMs: number): void {
    attach.idleTimer = setTimeout(() => {
      if (attach.state === 'closed') return;
      const last =
        attach.mode === 'write' ? attach.lastInputAt : attach.lastTrafficAt;
      const left = last + this.options.idleTimeoutMs - Date.now();
      if (left <= 0) {
        void this.end(attach, 'idle');
        return;
      }
      this.armIdle(attach, left);
    }, delayMs);
    attach.idleTimer.unref();
  }

  private async recordDetached(attach: TerminalAttach): Promise<void> {
    const reason = attach.endReason ?? 'client';
    const durationMs = Date.now() - attach.since;
    this.logger.log(
      `terminal ${attach.id} detached: ${reason}, ${durationMs} ms, in ${attach.bytesIn} B, out ${attach.bytesOut} B`,
    );
    await this.record(attach, 'terminal.detached', 'ok', {
      after: {
        reason,
        durationMs,
        bytesIn: attach.bytesIn,
        bytesOut: attach.bytesOut,
      },
      meta: {
        ticketId: attach.grant.ticketId,
        streamId: attach.id,
        mode: attach.mode,
        droppedIn: attach.droppedIn,
        ...(attach.endCause ? { cause: attach.endCause } : {}),
      },
    });
  }

  private async record(
    who: { grant: TerminalGrant; user: TerminalUser; origin: RequestOrigin },
    action: 'terminal.attached' | 'terminal.detached',
    result: 'ok' | 'denied' | 'error',
    detail: { after: object; meta: object },
  ): Promise<void> {
    try {
      await this.audit.record({
        actor: userActor(who.user.id),
        origin: who.origin,
        action,
        target: auditTarget(who.grant.target),
        projectId: who.grant.target.projectId,
        result,
        ...detail,
      });
    } catch (error) {
      this.logger.error(`audit ${action}: ${(error as Error).message}`);
    }
  }
}
