import { ACTION_REQUEST_TOOL_INPUT_MAX } from '@agentdock/shared';
import {
  cardRunFinishRefusedDataSchema,
  EVENT_SCHEMA_VERSION,
  HOOK_SESSION_ENDED_EVENT,
  HOOK_SESSION_STARTED_EVENT,
  type HookEventType,
  hookEventDataSchemas,
  type LocalErrorCode,
  manualTmuxSessionSchema,
  type UnsequencedEvent,
  type WatchedProject,
} from '@agentdock/shared/protocol';
import { z } from 'zod';
import { correlateCwd } from '../adapters/correlate';
import type { CardRecord } from '../cards/record';
import { errorMessage, type Logger } from '../log';
import type { EnvelopeProject } from '../otlp/map';
import { toHookContent } from './redact';
import type { HookSessions } from './sessions';
import {
  type ContentField,
  type LocalEventArgs,
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
  /**
   * #482: the live card round whose worktree holds `cwd`, from the card
   * store on disk — it outlives a daemon restart, the hook sessions do not.
   */
  liveRound?: (cwd: string) => CardRecord | null;
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
  args: z.looseObject({ input: z.unknown().optional() }),
});

/** Cuts a redacted tool input to the action request's limit (D17). */
const capToolInput = (text: string): string =>
  text.length > ACTION_REQUEST_TOOL_INPUT_MAX
    ? `${text.slice(0, ACTION_REQUEST_TOOL_INPUT_MAX - 1)}…`
    : text;

/**
 * The daemon's side of the local socket (spec 201 D5, D6, D9, D10, D13).
 * Everything that leaves the machine passes the content gate here, before
 * the spool or the WSS: hook processes send raw text, never trusted to
 * redact it themselves.
 */
export class LocalService {
  constructor(private readonly deps: LocalServiceDeps) {}

  async handle(op: LocalOp, args: unknown): Promise<LocalResult<unknown>> {
    try {
      switch (op) {
        case 'ping':
          return this.ping(args);
        case 'event':
          return await this.event(args);
        case 'request':
          return await this.request(args);
      }
    } catch (error) {
      this.deps.log.error('local: request failed', {
        op,
        error: errorMessage(error),
      });
      return localFail('internal', 'the daemon failed');
    }
  }

  private ping(args: unknown): LocalResult<LocalPingResult> {
    const parsed = localPingArgsSchema.safeParse(args ?? {});
    if (!parsed.success) return localFail('invalid_args', 'bad ping args');
    const cwd = parsed.data.cwd;
    const projectId = cwd
      ? (correlateCwd(cwd, this.deps.projects()).projectId ?? null)
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

  /** A hook event: correlated, gated, redacted, validated, spooled. */
  private async event(args: unknown): Promise<LocalResult<{ queued: true }>> {
    const parsed = localEventArgsSchema.safeParse(args);
    if (!parsed.success) {
      return localFail('invalid_args', z.prettifyError(parsed.error));
    }
    const input = parsed.data;
    const projects = this.deps.projects();
    const { projectId, slot } = correlateCwd(input.cwd, projects);
    this.track(input);

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
      session: { runtime: 'claude', id: input.sessionId },
      data: valid.data,
    });
    return { ok: true, data: { queued: true } };
  }

  private track(input: LocalEventArgs): void {
    const { sessions } = this.deps;
    if (input.type === HOOK_SESSION_STARTED_EVENT) {
      const tmux = manualTmuxSessionSchema.safeParse(
        (input.data as Record<string, unknown> | undefined)?.tmuxSession,
      );
      sessions.started(
        input.sessionId,
        input.cwd,
        input.ancestors ?? [],
        tmux.success ? tmux.data : undefined,
      );
    } else {
      sessions.seen(input.sessionId, input.cwd);
    }
    if (input.type === HOOK_SESSION_ENDED_EVENT) {
      sessions.ended(input.sessionId);
    }
  }

  /** A request relayed as `local.request`; never spooled (D6). */
  private async request(args: unknown): Promise<LocalResult<unknown>> {
    const parsed = localRequestArgsSchema.safeParse(args);
    if (!parsed.success) {
      return localFail('invalid_args', z.prettifyError(parsed.error));
    }
    const input = parsed.data;
    const projects = this.deps.projects();
    const projectId = input.cwd
      ? correlateCwd(input.cwd, projects).projectId
      : undefined;
    let round: CardRecord | null | undefined;
    const roundAt = (): CardRecord | null => {
      if (round === undefined) {
        round = input.cwd ? (this.deps.liveRound?.(input.cwd) ?? null) : null;
      }
      return round;
    };
    const sessionId = input.sessionId ?? this.sessionOf(input, roundAt);
    const result = await this.deps.relay({
      method: input.method,
      args: this.gate(input, shipsContent(projectId, projects)),
      ...(projectId ? { projectId } : {}),
      ...(sessionId ? { session: { runtime: 'claude', id: sessionId } } : {}),
      via: input.via,
    });
    if (input.method === 'card.finish' && !result.ok) {
      const refused = roundAt();
      if (refused) this.finishRefused(refused, result.error.code);
    }
    return result;
  }

  /**
   * The session of a caller that knows only its parent pid and cwd (D10):
   * the pid a `SessionStart` reported, else (#482) the session of the live
   * card round whose worktree holds the cwd — the card store survives a
   * daemon restart, the hook sessions do not — else the one live session
   * in that cwd.
   */
  private sessionOf(
    input: LocalRequestArgs,
    roundAt: () => CardRecord | null,
  ): string | null {
    const { sessions } = this.deps;
    return (
      sessions.byParent(input.ppid) ??
      roundAt()?.sessionId ??
      sessions.resolve(undefined, input.cwd)
    );
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
   * A `tool_use` action request carries the tool input only for a project
   * that ships content, redacted and cut to 500 characters (D17).
   */
  private gate(input: LocalRequestArgs, ships: boolean): unknown {
    if (input.method !== 'action.request') return input.args;
    const toolUse = toolUseArgsSchema.safeParse(input.args);
    if (!toolUse.success) return input.args;
    const { input: raw, ...rest } = toolUse.data.args;
    const keep =
      ships && typeof raw === 'string' && raw.length > 0
        ? { input: capToolInput(toolHookText(raw)) }
        : {};
    return { ...toolUse.data, args: { ...rest, ...keep } };
  }
}

const toolHookText = (raw: string): string =>
  toHookContent(raw, false, ACTION_REQUEST_TOOL_INPUT_MAX * 4).text;
