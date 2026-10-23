import {
  cardRunFinishRefusedDataSchema,
  EVENT_SCHEMA_VERSION,
  HOOK_SESSION_ENDED_EVENT,
  HOOK_SESSION_STARTED_EVENT,
  type HookEventType,
  hookEventDataSchemas,
  isHookEventType,
  isLocalMethodName,
  type LocalErrorCode,
  localMethods,
  manualTmuxSessionSchema,
  type UnsequencedEvent,
  type WatchedProject,
} from '@nautelle/shared/protocol';
import { z } from 'zod';
import { correlateCwd } from '../adapters/correlate';
import { ARTIFACT_INCOMPLETE, FinishGuard } from '../cards/finish-guard';
import type { CardRecord } from '../cards/record';
import { errorMessage, type Logger } from '../log';
import type { EnvelopeProject } from '../otlp/map';
import { toHookContent, toToolInputPreview } from './redact';
import {
  cwdWithin,
  type SessionBinding,
  type SessionTokens,
} from './session-tokens';
import { type HookSessions, isClaude } from './sessions';
import {
  type Ancestor,
  type ContentField,
  type LocalCaller,
  type LocalEventArgs,
  type LocalEventResult,
  type LocalOp,
  type LocalPingResult,
  type LocalRelayRequest,
  type LocalRequestArgs,
  type LocalResult,
  localEventArgsSchema,
  localFail,
  localPingArgsSchema,
  localRequestArgsSchema,
} from './types';

/** #750 D8: the round whose worker called `escalate_card`, as it was then. */
export interface EscalatedRound {
  cardId: string;
  runId: string;
  sessionId: string;
}

export interface LocalServiceDeps {
  projects: () => readonly WatchedProject[];
  awayMode: () => boolean;
  /** The WSS is live; a relayed request would reach the server. */
  online: () => boolean;
  /** Into the spool, as every other event (ADR-0020 §3). */
  emit: (event: UnsequencedEvent) => void;
  /** `local.request` over the WSS; answers `runner_offline` itself when it is down. */
  relay: (request: LocalRelayRequest) => Promise<LocalResult<unknown>>;
  /** The envelope `project` of a watched project id, resolved through git. */
  envelope: (projectId: string) => Promise<EnvelopeProject | undefined>;
  sessions: HookSessions;
  /** #113: mints and checks the session tokens every caller presents. */
  tokens: SessionTokens;
  /**
   * #113: a process and its ancestors, nearest first, read by the daemon —
   * absent where it cannot read them; the peer check is then skipped.
   */
  ancestorsOf?: (pid: number) => Promise<Ancestor[]>;
  /** #113: the process exists; a registered session's `claude` is still alive. */
  alive?: (pid: number) => boolean;
  /**
   * #113: the session is a live card round the runner launched. Its token
   * came with its env, so a `SessionStart` without one is not it.
   */
  launchedSession?: (sessionId: string) => boolean;
  /**
   * #482: the live card round whose worktree holds `cwd`, from the card
   * store on disk — it outlives a daemon restart, the hook sessions do not.
   */
  liveRound?: (cwd: string) => CardRecord | null;
  /**
   * #750 D8: stop this round once `escalate_card` has answered its worker —
   * only while it is still the card's round in that session (the executor
   * checks), so the API's relaunch on Opus is never stopped.
   */
  stopRoundSoon?: (round: EscalatedRound) => void;
  /** #445 D8: a worktree's pull request description; read from disk by default. */
  readDescription?: (worktree: string) => string | null;
  now: () => string;
  log: Logger;
}

/** The content fields each hook event may carry (D11). */
const CONTENT_OF: Record<HookEventType, readonly ContentField[]> = {
  'hook.session_started': [],
  'hook.prompt_submitted': ['content'],
  'hook.tool_finished': ['input', 'output'],
  'hook.permission_requested': [],
  'hook.notification': [],
  'hook.stopped': ['response', 'background'],
  'hook.pre_compact': [],
  'hook.session_ended': [],
};

/** What the gate decides for one session's cwd (ADR-0021 §3). */
const shipsContent = (
  projectId: string | undefined,
  projects: readonly WatchedProject[],
): boolean =>
  projectId !== undefined &&
  projects.find((p) => p.id === projectId)?.shipContent === true;

const toolUseArgsSchema = z.looseObject({
  kind: z.literal('tool_use'),
  args: z.looseObject({
    input: z.unknown().optional(),
    truncated: z.unknown().optional(),
    fullLength: z.unknown().optional(),
    sha256: z.unknown().optional(),
    preview: z.unknown().optional(),
  }),
});

/** A caller the daemon will not act for (#113). */
const refused = (
  message: string,
): { ok: false; error: { code: 'forbidden'; message: string } } => ({
  ok: false,
  error: { code: 'forbidden', message },
});

/**
 * The daemon's side of the local socket (spec 201 D5, D6, D9, D10, D13).
 * Everything that leaves the machine passes the content gate here, before
 * the spool or the WSS: hook processes send raw text, never trusted to
 * redact it themselves.
 *
 * #113: a caller is never trusted for its `cwd` or `sessionId`. Each call
 * carries the session token, whose binding is the session and the project;
 * a claim outside it is refused, and so is a peer that does not descend from
 * the session's `claude` where the kernel names the peer. Only a
 * `SessionStart` registers without a token — and is answered with one.
 */
export class LocalService {
  /** #445 D8, DR-10: each card's guard for its current round, by card id. */
  private readonly finishGuards = new Map<
    string,
    { runId: string; guard: FinishGuard }
  >();

  constructor(private readonly deps: LocalServiceDeps) {}

  async handle(
    op: LocalOp,
    args: unknown,
    caller: LocalCaller = { peerPid: null },
  ): Promise<LocalResult<unknown>> {
    try {
      switch (op) {
        case 'ping':
          return this.ping(args, caller);
        case 'event':
          return await this.event(args, caller);
        case 'request':
          return await this.request(args, caller);
      }
    } catch (error) {
      this.deps.log.error('local: request failed', {
        op,
        error: errorMessage(error),
      });
      return localFail('internal', 'the daemon failed');
    }
  }

  /**
   * Liveness answers anyone; the project only a caller whose token binds
   * the `cwd` it asks about.
   */
  private ping(
    args: unknown,
    caller: LocalCaller,
  ): LocalResult<LocalPingResult> {
    const parsed = localPingArgsSchema.safeParse(args ?? {});
    if (!parsed.success) return localFail('invalid_args', 'bad ping args');
    const cwd = parsed.data.cwd;
    const binding = caller.token ? this.deps.tokens.verify(caller.token) : null;
    const projectId =
      cwd && binding && cwdWithin(cwd, binding.cwd)
        ? (correlateCwd(binding.cwd, this.deps.projects()).projectId ?? null)
        : null;
    return {
      ok: true,
      data: {
        pong: true,
        online: this.deps.online(),
        awayMode: this.deps.awayMode(),
        projectId,
      },
    };
  }

  /** A hook event: authenticated, correlated, gated, redacted, validated, spooled. */
  private async event(
    args: unknown,
    caller: LocalCaller,
  ): Promise<LocalResult<LocalEventResult>> {
    // Any process of a session can call: only the hook types go on (C-169).
    const claimed = (args as { type?: unknown } | null)?.type;
    if (typeof claimed === 'string' && !isHookEventType(claimed)) {
      this.deps.log.warn('local: refused an event type outside the hooks', {
        type: claimed.slice(0, 64),
        peerPid: caller.peerPid,
      });
      return refused(`${claimed.slice(0, 64)} is not a hook event`);
    }
    const parsed = localEventArgsSchema.safeParse(args);
    if (!parsed.success) {
      return localFail('invalid_args', z.prettifyError(parsed.error));
    }
    const input = parsed.data;
    const starting = input.type === HOOK_SESSION_STARTED_EVENT;
    const auth =
      starting && !caller.token
        ? await this.register(input, caller)
        : await this.authenticate(caller, input);
    if (!auth.ok) return auth;
    const { binding, ancestors } = auth.data;
    const projects = this.deps.projects();
    const { projectId, slot } = correlateCwd(binding.cwd, projects);
    this.track(input, ancestors);

    const data: Record<string, unknown> = { ...input.data };
    for (const field of CONTENT_OF[input.type]) delete data[field];
    if (shipsContent(projectId, projects)) {
      for (const field of CONTENT_OF[input.type]) {
        const raw = input.content?.[field];
        if (raw) data[field] = toHookContent(raw.text, raw.truncated);
      }
    }
    const valid = hookEventDataSchemas[input.type].safeParse(data);
    if (!valid.success) {
      return localFail('invalid_args', z.prettifyError(valid.error));
    }
    const project = projectId ? await this.deps.envelope(projectId) : undefined;
    this.deps.emit({
      v: EVENT_SCHEMA_VERSION,
      ts: this.deps.now(),
      type: input.type,
      source: 'hook',
      ...(project ? { project } : {}),
      ...(slot ? { slot } : {}),
      session: { runtime: 'claude', id: binding.sessionId },
      data: valid.data,
    });
    if (!starting) return { ok: true, data: { queued: true } };
    // The hook keeps it for the session's later hooks and its MCP server.
    const token = caller.token ?? this.deps.tokens.mint(binding);
    return { ok: true, data: { queued: true, token } };
  }

  /**
   * #113: the caller's token, checked — the binding it stands for, else a
   * refusal. A claimed `sessionId` must be the binding's, a claimed `cwd`
   * inside its cwd, and the peer, where the kernel names it, a descendant
   * of the session's `claude`. The ancestors the daemon read on the way
   * are returned, for a `SessionStart`.
   */
  private async authenticate(
    caller: LocalCaller,
    claim: { sessionId?: string; cwd?: string },
  ): Promise<
    LocalResult<{ binding: SessionBinding; ancestors: Ancestor[] | null }>
  > {
    if (!caller.token) return refused('no session token');
    const binding = this.deps.tokens.verify(caller.token);
    if (!binding) return refused('the session token is not valid');
    if (
      claim.sessionId !== undefined &&
      claim.sessionId !== binding.sessionId
    ) {
      return refused('the session token is another session’s');
    }
    if (claim.cwd !== undefined && !cwdWithin(claim.cwd, binding.cwd)) {
      return refused('the cwd is outside the session’s');
    }
    const ancestors = await this.peerAncestors(caller);
    const claudePid = this.deps.sessions.claudePidOf(binding.sessionId);
    if (
      ancestors !== null &&
      claudePid !== null &&
      !ancestors.some((a) => a.pid === claudePid)
    ) {
      this.deps.log.warn('local: a peer outside the session was refused', {
        sessionId: binding.sessionId,
        peerPid: caller.peerPid,
      });
      return refused('the caller is not a process of the session');
    }
    return { ok: true, data: { binding, ancestors } };
  }

  /**
   * #113: a `SessionStart` without a token — a session the runner did not
   * launch. Refused for a session the runner launched (its token is in its
   * env) and for one whose live `claude` is another process than the
   * caller's.
   */
  private async register(
    input: LocalEventArgs,
    caller: LocalCaller,
  ): Promise<
    LocalResult<{ binding: SessionBinding; ancestors: Ancestor[] | null }>
  > {
    if (this.deps.launchedSession?.(input.sessionId)) {
      return refused('a launched session registers with its own token');
    }
    const ancestors = await this.peerAncestors(caller);
    const known = this.deps.sessions.claudePidOf(input.sessionId);
    if (known !== null && (this.deps.alive?.(known) ?? true)) {
      const claude = (ancestors ?? input.ancestors ?? []).find((a) =>
        isClaude(a.comm),
      );
      if (claude?.pid !== known) {
        return refused('the session is registered to another process');
      }
    }
    return {
      ok: true,
      data: {
        binding: { sessionId: input.sessionId, cwd: input.cwd },
        ancestors,
      },
    };
  }

  /** The peer and its ancestors as the daemon reads them; null when it cannot. */
  private async peerAncestors(caller: LocalCaller): Promise<Ancestor[] | null> {
    const { ancestorsOf } = this.deps;
    if (caller.peerPid === null || !ancestorsOf) return null;
    try {
      return await ancestorsOf(caller.peerPid);
    } catch {
      return [];
    }
  }

  /**
   * A session's processes as the daemon read them win over those its hook
   * reported (D10): a hook could name any pid.
   */
  private track(input: LocalEventArgs, read: Ancestor[] | null): void {
    const { sessions } = this.deps;
    if (input.type === HOOK_SESSION_STARTED_EVENT) {
      const tmux = manualTmuxSessionSchema.safeParse(
        (input.data as Record<string, unknown> | undefined)?.tmuxSession,
      );
      sessions.started(
        input.sessionId,
        input.cwd,
        read ?? input.ancestors ?? [],
        tmux.success ? tmux.data : undefined,
      );
    } else {
      sessions.seen(input.sessionId, input.cwd);
    }
    if (input.type === HOOK_SESSION_ENDED_EVENT) {
      sessions.ended(input.sessionId);
    }
  }

  /**
   * A request relayed as `local.request`; never spooled (D6). The project
   * and the session are the token's (#113). A runner-wide method (`away.set`)
   * may come without one, and then goes with neither.
   */
  private async request(
    args: unknown,
    caller: LocalCaller,
  ): Promise<LocalResult<unknown>> {
    const parsed = localRequestArgsSchema.safeParse(args);
    if (!parsed.success) {
      return localFail('invalid_args', z.prettifyError(parsed.error));
    }
    const input = parsed.data;
    if (!caller.token && runnerWide(input.method)) {
      return this.deps.relay({
        method: input.method,
        args: input.args,
        via: input.via,
      });
    }
    const auth = await this.authenticate(caller, input);
    if (!auth.ok) return auth;
    const { binding } = auth.data;
    const projects = this.deps.projects();
    const projectId = correlateCwd(binding.cwd, projects).projectId;
    // #750 D8: the asking round is fixed before the call — the API may start
    // the relaunch on Opus before it answers.
    const asking =
      input.method === 'card.escalate'
        ? this.escalatingRound(binding.cwd, binding.sessionId)
        : null;
    let relayed = this.gate(input);
    if (input.method === 'card.finish') {
      const guarded = this.guardFinish(binding, relayed);
      if (!guarded.ok) return guarded;
      relayed = guarded.data;
    }
    const result = await this.deps.relay({
      method: input.method,
      args: relayed,
      ...(projectId ? { projectId } : {}),
      session: { runtime: 'claude', id: binding.sessionId },
      via: input.via,
    });
    if (input.method === 'card.escalate' && result.ok && asking) {
      this.deps.stopRoundSoon?.(asking);
    }
    if (input.method === 'card.finish' && !result.ok) {
      // #482: the round of the session's worktree, from the card store.
      const round = this.deps.liveRound?.(binding.cwd) ?? null;
      if (round?.sessionId === binding.sessionId) {
        this.finishRefused(round, result.error.code);
      }
    }
    return result;
  }

  /**
   * #445 D8 on the daemon's side of the socket (DR-10): a guarded round's
   * incomplete finish is refused with what is missing, twice; the third goes
   * on with `artifactIncomplete: true`. Whatever the caller claims about
   * `artifactIncomplete` is dropped — only the guard sets it (DA-18).
   */
  private guardFinish(
    binding: SessionBinding,
    args: unknown,
  ): LocalResult<unknown> {
    if (typeof args !== 'object' || args === null)
      return { ok: true, data: args };
    const { artifactIncomplete: _claimed, ...rest } = args as Record<
      string,
      unknown
    >;
    const round = this.deps.liveRound?.(binding.cwd) ?? null;
    if (!round?.finishGuard || round.sessionId !== binding.sessionId) {
      return { ok: true, data: rest };
    }
    let guard = this.finishGuards.get(round.cardId);
    if (guard?.runId !== round.runId) {
      // A new round starts with no rejections.
      guard = {
        runId: round.runId,
        guard: new FinishGuard({
          ...round.finishGuard,
          worktree: round.worktree,
          ...(this.deps.readDescription
            ? { read: this.deps.readDescription }
            : {}),
        }),
      };
      this.finishGuards.set(round.cardId, guard);
    }
    const summary = typeof rest.summary === 'string' ? rest.summary : '';
    const decision = guard.guard.check(summary);
    if (decision.kind === 'reject') {
      return localFail(ARTIFACT_INCOMPLETE, decision.message);
    }
    return {
      ok: true,
      data: decision.artifactIncomplete
        ? { ...rest, artifactIncomplete: true }
        : rest,
    };
  }

  /** #750 D8: the live round of the caller's worktree, if it is the caller's session. */
  private escalatingRound(
    cwd: string,
    sessionId: string,
  ): EscalatedRound | null {
    const round = this.deps.liveRound?.(cwd) ?? null;
    if (!round || round.sessionId !== sessionId) return null;
    return { cardId: round.cardId, runId: round.runId, sessionId };
  }

  /**
   * #482: the API refused a live round's `finish_card` — reported, so the
   * card needs attention with the reason instead of waiting in silence.
   */
  private finishRefused(round: CardRecord, code: LocalErrorCode): void {
    const at = this.deps.now();
    this.deps.emit({
      v: EVENT_SCHEMA_VERSION,
      ts: at,
      type: 'card_run.finish_refused',
      source: 'runner',
      project: { repo: round.repo, root: round.root },
      data: cardRunFinishRefusedDataSchema.parse({
        cardId: round.cardId,
        runId: round.runId,
        projectId: round.projectId,
        at,
        code,
      }),
    });
    this.deps.log.warn('local: finish_card was refused', {
      cardId: round.cardId,
      runId: round.runId,
      code,
    });
  }

  /**
   * A `tool_use` action request always carries the redacted tool input —
   * a security control, not content, so independent of content shipping
   * (C-114, D-08): whole, or head and tail with `fullLength` and `sha256`
   * of the full redacted input. Without one it is marked `preview: 'none'`.
   * What the caller claims about the preview is dropped and recomputed.
   */
  private gate(input: LocalRequestArgs): unknown {
    if (input.method !== 'action.request') return input.args;
    const toolUse = toolUseArgsSchema.safeParse(input.args);
    if (!toolUse.success) return input.args;
    const {
      input: raw,
      truncated: _truncated,
      fullLength: _fullLength,
      sha256: _sha256,
      preview: _preview,
      ...rest
    } = toolUse.data.args;
    const preview =
      typeof raw === 'string' && raw.length > 0
        ? toToolInputPreview(raw)
        : { preview: 'none' as const };
    return { ...toolUse.data, args: { ...rest, ...preview } };
  }
}

/** A method that acts for the runner, not a project or a session (D17). */
const runnerWide = (method: string): boolean =>
  isLocalMethodName(method) && !localMethods[method].needsProject;
