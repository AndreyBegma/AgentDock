import { basename } from 'node:path';
import type { WatchedProject } from '@agentdock/shared/protocol';
import { correlateCwd } from '../adapters/correlate';
import type { Ancestor } from './types';

/** Sessions kept for MCP and OTLP lookups; the oldest is forgotten first. */
export const HOOK_SESSIONS_MAX = 1_000;

interface HookSession {
  id: string;
  cwd: string;
  claudePid: number | null;
  ended: boolean;
}

/** `claude`, or a path or argv0 ending in it, possibly with a version suffix. */
const isClaude = (comm: string): boolean =>
  /^claude(\b|$)/.test(basename(comm.trim()));

/**
 * The sessions hooks have reported (spec 201 D10, D22), in memory only:
 * Claude Code's session id → its cwd, and the pid of its `claude` process.
 * MCP processes, which get no session id, are matched by their parent pid,
 * else by the one live session in their cwd. The OTLP receiver correlates a
 * record without `agentdock.project` through the cwd kept here.
 */
export class HookSessions {
  private readonly sessions = new Map<string, HookSession>();
  private readonly byPid = new Map<number, string>();

  constructor(private readonly max = HOOK_SESSIONS_MAX) {}

  /** Any hook event of a session: it exists and works in `cwd`. */
  seen(sessionId: string, cwd: string): void {
    const known = this.sessions.get(sessionId);
    if (known) {
      known.cwd = cwd;
      // Most recent last, so eviction drops the least recently seen.
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, known);
      return;
    }
    this.sessions.set(sessionId, {
      id: sessionId,
      cwd,
      claudePid: null,
      ended: false,
    });
    this.evict();
  }

  /** `SessionStart`: the nearest `claude` among the hook's ancestors is the session's process. */
  started(
    sessionId: string,
    cwd: string,
    ancestors: readonly Ancestor[],
  ): void {
    this.seen(sessionId, cwd);
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.ended = false;
    const claude = ancestors.find((a) => isClaude(a.comm));
    if (!claude) return;
    if (session.claudePid !== null) this.byPid.delete(session.claudePid);
    session.claudePid = claude.pid;
    this.byPid.set(claude.pid, sessionId);
  }

  ended(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.ended = true;
    if (session.claudePid !== null) {
      this.byPid.delete(session.claudePid);
      session.claudePid = null;
    }
  }

  /**
   * The session of a process that knows only its parent pid and cwd (D10):
   * the pid map, else the single live session in that cwd, else none.
   */
  resolve(ppid: number | undefined, cwd: string | undefined): string | null {
    if (ppid !== undefined) {
      const byPid = this.byPid.get(ppid);
      if (byPid) return byPid;
    }
    if (cwd === undefined) return null;
    const live = [...this.sessions.values()].filter(
      (s) => !s.ended && s.cwd === cwd,
    );
    return live.length === 1 ? live[0].id : null;
  }

  cwdOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.cwd;
  }

  /** The watched project of a session's cwd (D22), now. */
  projectOf(
    sessionId: string,
    projects: readonly WatchedProject[],
  ): string | undefined {
    const cwd = this.cwdOf(sessionId);
    return cwd ? correlateCwd(cwd, projects).projectId : undefined;
  }

  get size(): number {
    return this.sessions.size;
  }

  private evict(): void {
    while (this.sessions.size > this.max) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) return;
      const session = this.sessions.get(oldest);
      if (session?.claudePid != null) this.byPid.delete(session.claudePid);
      this.sessions.delete(oldest);
    }
  }
}
