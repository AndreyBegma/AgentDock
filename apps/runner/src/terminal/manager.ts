import {
  TERMINAL_ATTACH_TIMEOUT_MS,
  TERMINAL_IDLE_TIMEOUT_SEC_DEFAULT,
  TERMINAL_MAX_ATTACHES_PER_RUNNER,
  TERMINAL_MAX_DATA_BYTES,
  TERMINAL_MAX_DURATION_SEC_DEFAULT,
  type TerminalAttachArgs,
  type TerminalAttachResult,
  type TerminalCloseMessage,
  type TerminalCloseReason,
  type TerminalDataMessage,
  type TerminalMode,
  type TerminalResizeMessage,
  type WatchedProject,
} from '@agentdock/shared/protocol';
import type { Cancel, Clock } from '../clock';
import { CommandFailure } from '../commands/failure';
import type { Exec } from '../detect/exec';
import { errorMessage, type Logger } from '../log';
import { attachArgv, type PtyProcess, type SpawnPty } from './pty';
import { resolveTerminalTarget } from './resolve';

export type TerminalOutbound = TerminalDataMessage | TerminalCloseMessage;

export interface TerminalManagerOptions {
  exec: Exec;
  clock: Clock;
  log: Logger;
  /** The current watch list, as the server last sent it. */
  watchedProjects: () => readonly WatchedProject[];
  /** Sends to the server; false when the socket is not open. */
  send: (message: TerminalOutbound) => boolean;
  spawn: SpawnPty;
  /**
   * Why this machine cannot attach (no PTY API, tmux < 3.2), or null when it
   * can; absent means it can. Answered with `unsupported` (D3).
   */
  unsupported?: () => Promise<string | null>;
  /** The tmux server: empty for the user's own, `['-L', name]` in tests. */
  tmuxServer?: readonly string[];
  maxAttaches?: number;
  idleTimeoutMs?: number;
  maxDurationMs?: number;
  /** How long a client gets to exit after SIGHUP before SIGKILL. */
  killGraceMs?: number;
}

/** The SIGHUP → SIGKILL grace; well inside the 5 s the spec allows to end a client. */
export const TERMINAL_KILL_GRACE_MS = 2_000;

interface Attach {
  id: string;
  session: string;
  mode: TerminalMode;
  proc: PtyProcess;
  startedAt: number;
  /** Input bytes written to the PTY (`write` only). */
  bytesIn: number;
  /** Output bytes read from the PTY. */
  bytesOut: number;
  /** Input bytes refused on a `read` attach. */
  bytesDropped: number;
  /** Last input (`write`) or last traffic of either direction (`read`), D7. */
  lastActivity: number;
  closed: boolean;
  cancelIdle: Cancel;
  cancelMax: Cancel;
  cancelKill: Cancel;
}

/**
 * Interactive attaches (spec 29, runner side). The server opens one with the
 * `terminal.attach` command; the runner resolves the target itself (D2),
 * spawns `tmux attach-session` in a PTY (D3, D4) and streams its bytes as
 * `terminal.data`. Limits (D6, D7) are enforced here as well as on the API.
 * Every close signals the attach client only — no path here kills a session.
 * Bytes are never logged; detach logs carry counts (D8).
 */
export class TerminalManager {
  private readonly attaches = new Map<string, Attach>();
  /** Ids being resolved; `true` once a close or reset cancelled them. */
  private readonly pending = new Map<string, boolean>();
  private readonly maxAttaches: number;
  private readonly idleTimeoutMs: number;
  private readonly maxDurationMs: number;
  private readonly killGraceMs: number;

  constructor(private readonly options: TerminalManagerOptions) {
    this.maxAttaches = options.maxAttaches ?? TERMINAL_MAX_ATTACHES_PER_RUNNER;
    this.idleTimeoutMs =
      options.idleTimeoutMs ?? TERMINAL_IDLE_TIMEOUT_SEC_DEFAULT * 1000;
    this.maxDurationMs =
      options.maxDurationMs ?? TERMINAL_MAX_DURATION_SEC_DEFAULT * 1000;
    this.killGraceMs = options.killGraceMs ?? TERMINAL_KILL_GRACE_MS;
  }

  get attachCount(): number {
    return this.attaches.size;
  }

  /** The `terminal.attach` handler. Answers once the PTY is running. */
  async attach(args: TerminalAttachArgs): Promise<TerminalAttachResult> {
    const { id, mode, cols, rows } = args;
    const { clock, log } = this.options;
    if (this.attaches.has(id) || this.pending.has(id)) {
      throw new CommandFailure('busy', `stream ${id} is already attached`);
    }
    this.ensureCapacity();
    const started = clock.now();
    const session = await this.resolvePending(args);
    // The server gave up on this command; a PTY now would be an orphan.
    if (clock.now() - started >= TERMINAL_ATTACH_TIMEOUT_MS) {
      throw new Error(`resolving ${id} outlived the command timeout`);
    }
    this.ensureCapacity();
    if (mode === 'write') {
      for (const other of this.attaches.values()) {
        if (other.session === session && other.mode === 'write') {
          throw new CommandFailure(
            'busy',
            `${session} is already attached read-write`,
          );
        }
      }
    }

    // Bun delivers PTY data on a later tick, after `attach` is assigned.
    let attach: Attach | undefined;
    let proc: PtyProcess;
    try {
      proc = this.options.spawn({
        argv: attachArgv(this.options.tmuxServer ?? [], session, mode),
        cols,
        rows,
        onData: (bytes) => {
          if (attach) this.output(attach, bytes);
        },
      });
    } catch (error) {
      log.error('terminal: cannot spawn the attach client', {
        id,
        session,
        error: errorMessage(error),
      });
      throw new Error(`cannot attach to ${session}`);
    }
    const now = clock.now();
    const opened: Attach = {
      id,
      session,
      mode,
      proc,
      startedAt: now,
      bytesIn: 0,
      bytesOut: 0,
      bytesDropped: 0,
      lastActivity: now,
      closed: false,
      cancelIdle: () => {},
      cancelMax: () => {},
      cancelKill: () => {},
    };
    attach = opened;
    this.attaches.set(id, opened);
    this.armIdle(opened, this.idleTimeoutMs);
    opened.cancelMax = clock.setTimeout(
      () => this.finish(opened, 'max_duration', true),
      this.maxDurationMs,
    );
    const onExit = () => this.exited(opened);
    void proc.exited.then(onExit, onExit);
    log.info('terminal: attached', { id, session, mode, cols, rows });
    return { attached: true, session };
  }

  /** `terminal.data` from the server: input, written only on a `write` attach (D4, D6). */
  data(message: TerminalDataMessage): void {
    const attach = this.attaches.get(message.id);
    if (!attach) return;
    const bytes = Buffer.from(message.b64, 'base64');
    if (attach.mode === 'read') {
      // Defence in depth: the API drops input on a read attach too.
      attach.bytesDropped += bytes.length;
      attach.lastActivity = this.options.clock.now();
      return;
    }
    attach.bytesIn += bytes.length;
    attach.lastActivity = this.options.clock.now();
    attach.proc.write(bytes);
  }

  resize(message: TerminalResizeMessage): void {
    this.attaches.get(message.id)?.proc.resize(message.cols, message.rows);
  }

  /** `terminal.close` from the server: nothing more is sent for that id. */
  close(message: TerminalCloseMessage): void {
    if (this.pending.has(message.id)) this.pending.set(message.id, true);
    const attach = this.attaches.get(message.id);
    if (attach) this.finish(attach, message.reason, false);
  }

  /** The socket dropped: every attach ends; the server audits `socket`. */
  reset(): void {
    for (const id of this.pending.keys()) this.pending.set(id, true);
    for (const attach of [...this.attaches.values()]) {
      this.finish(attach, 'socket', false);
    }
  }

  stop(): void {
    this.reset();
  }

  /**
   * Checks the machine and resolves the target with the id held as pending:
   * it counts against the cap, and a close or reset meanwhile cancels it.
   */
  private async resolvePending(args: TerminalAttachArgs): Promise<string> {
    this.pending.set(args.id, false);
    try {
      const unsupported = await this.options.unsupported?.();
      if (unsupported) throw new CommandFailure('unsupported', unsupported);
      const session = await resolveTerminalTarget(args.target, {
        exec: this.options.exec,
        watchedProjects: this.options.watchedProjects,
        tmuxServer: this.options.tmuxServer,
      });
      if (this.pending.get(args.id) === true) {
        throw new Error(`stream ${args.id} was closed while attaching`);
      }
      return session;
    } finally {
      this.pending.delete(args.id);
    }
  }

  private ensureCapacity(): void {
    if (this.attaches.size + this.pending.size >= this.maxAttaches) {
      throw new CommandFailure(
        'busy',
        `this runner already holds ${this.maxAttaches} attaches`,
      );
    }
  }

  private output(attach: Attach, bytes: Uint8Array): void {
    if (attach.closed) return;
    attach.bytesOut += bytes.length;
    if (attach.mode === 'read') {
      attach.lastActivity = this.options.clock.now();
    }
    for (let at = 0; at < bytes.length; at += TERMINAL_MAX_DATA_BYTES) {
      const chunk = bytes.subarray(at, at + TERMINAL_MAX_DATA_BYTES);
      this.options.send({
        type: 'terminal.data',
        id: attach.id,
        b64: Buffer.from(chunk).toString('base64'),
      });
    }
  }

  /** Fires after `ms`; closes when nothing happened since, else re-arms for the rest. */
  private armIdle(attach: Attach, ms: number): void {
    attach.cancelIdle = this.options.clock.setTimeout(() => {
      const quiet = this.options.clock.now() - attach.lastActivity;
      if (quiet >= this.idleTimeoutMs) this.finish(attach, 'idle', true);
      else this.armIdle(attach, this.idleTimeoutMs - quiet);
    }, ms);
  }

  private exited(attach: Attach): void {
    attach.cancelKill();
    attach.proc.close();
    if (!attach.closed) this.finish(attach, 'session_ended', true);
  }

  private finish(
    attach: Attach,
    reason: TerminalCloseReason,
    notify: boolean,
  ): void {
    if (attach.closed) return;
    const { clock, log } = this.options;
    attach.closed = true;
    attach.cancelIdle();
    attach.cancelMax();
    this.attaches.delete(attach.id);
    if (notify) {
      this.options.send({ type: 'terminal.close', id: attach.id, reason });
    }
    if (reason !== 'session_ended') {
      // The attach client only; the session it was attached to keeps running.
      attach.proc.kill('SIGHUP');
      attach.cancelKill = clock.setTimeout(
        () => attach.proc.kill('SIGKILL'),
        this.killGraceMs,
      );
    }
    log.info('terminal: detached', {
      id: attach.id,
      session: attach.session,
      mode: attach.mode,
      reason,
      durationMs: clock.now() - attach.startedAt,
      bytesIn: attach.bytesIn,
      bytesOut: attach.bytesOut,
      bytesDropped: attach.bytesDropped,
    });
  }
}
