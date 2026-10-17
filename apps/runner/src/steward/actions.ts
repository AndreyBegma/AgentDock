import {
  STEWARD_NUDGE_MAX_PER_ROUND,
  STEWARD_NUDGE_TEXT,
  STEWARD_RESUME_MAX_PER_ROUND,
  type StewardActableSubject,
  type StewardAction,
} from '@agentdock/shared';
import type {
  CardResumeArgs,
  CardResumeResult,
  CommandArgs,
  CommandResult,
  SessionDismissArgs,
  SessionDismissResult,
  SessionNudgeArgs,
  SessionNudgeResult,
  StewardCommandName,
  WatchedProject,
} from '@agentdock/shared/protocol';
import type { CardRecord } from '../cards/record';
import type { Clock } from '../clock';
import { CommandFailure } from '../commands/failure';
import { errorMessage, type Logger } from '../log';
import { stewardConfigOf } from './config';
import { emitActed, type StewardEmit, type StewardEnvelope } from './emit';

/** What the Steward commands need of the card executor. */
export interface StewardCardTarget {
  /** The card's record, when it is on this runner. */
  record(cardId: string): CardRecord | null;
  /** The live tmux session of a running round; null otherwise. */
  liveSession(projectId: string, cardId: string, runId: string): string | null;
  typeAtPrompt(session: string, text: string): Promise<boolean>;
  dismissDialog(session: string, dialogId: string): Promise<boolean>;
  resume(args: CardResumeArgs): Promise<CardResumeResult>;
}

/** A runner run: its live tmux session, and its envelope. */
export interface StewardRunTarget {
  run(
    projectId: string,
    runId: string,
  ): { session: string | null; envelope: StewardEnvelope } | null;
}

export interface StewardActionsOptions {
  cards: StewardCardTarget;
  runs?: StewardRunTarget;
  watchedProjects: () => readonly WatchedProject[];
  emit: StewardEmit;
  clock: Clock;
  log: Logger;
  /** A resumed round's observation starts over. */
  onResumed?: (record: Pick<CardRecord, 'cardId' | 'runId'>) => void;
}

export type StewardHandlers = {
  [N in StewardCommandName]: (
    args: CommandArgs<N>,
  ) => Promise<CommandResult<N>>;
};

/** The per-round limits the runner keeps besides the API's (D9, D10). */
const LIMIT: Partial<Record<StewardAction, number>> = {
  nudge: STEWARD_NUDGE_MAX_PER_ROUND,
  resume: STEWARD_RESUME_MAX_PER_ROUND,
};

const subjectKey = (subject: StewardActableSubject): string =>
  subject.kind === 'card_round'
    ? `card:${subject.cardId}:${subject.runId}`
    : `run:${subject.runId}`;

/**
 * #447 D2, D9–D11, ADR-0010: the runner's Steward commands. The API decides
 * — the rules, the project's switches, the per-round limits — and the runner
 * executes, bounded and audited:
 * - the tmux session is resolved from the subject, never taken from args;
 * - a nudge types the one fixed line, only at an empty idle prompt;
 * - a dismiss answers only the listed dialog the pane still shows, never a
 *   permission prompt;
 * - a resume restarts the same session in the same worktree;
 * - every attempt is a `steward.acted` event, and the runner refuses an
 *   attempt past the per-round limit itself (`busy`), whatever the API says.
 */
export class StewardActions {
  /** Attempts per subject and action, since this runner started. */
  private readonly attempts = new Map<string, number>();

  constructor(private readonly options: StewardActionsOptions) {}

  handlers(): Omit<StewardHandlers, 'digest.compose'> {
    return {
      'session.nudge': (args) => this.nudge(args),
      'session.dismiss': (args) => this.dismiss(args),
      'card.resume': (args) => this.resume(args),
    };
  }

  async nudge(args: SessionNudgeArgs): Promise<SessionNudgeResult> {
    this.stewardOn(args.projectId);
    const target = this.target(args.projectId, args.subject);
    this.count(args.subject, 'nudge');
    let sent = false;
    let detail: string | undefined;
    if (target.session === null) {
      detail = 'the session is gone';
    } else {
      try {
        sent = await this.options.cards.typeAtPrompt(
          target.session,
          STEWARD_NUDGE_TEXT,
        );
        if (!sent) detail = 'the session was not at an idle prompt';
      } catch (error) {
        this.options.log.warn('steward: a nudge failed', {
          error: errorMessage(error),
        });
        detail = 'typing into the session failed';
      }
    }
    this.acted(
      args.projectId,
      target.envelope,
      args.subject,
      'nudge',
      sent,
      detail,
    );
    return { sent };
  }

  async dismiss(args: SessionDismissArgs): Promise<SessionDismissResult> {
    this.stewardOn(args.projectId);
    const target = this.target(args.projectId, args.subject);
    let dismissed = false;
    let detail: string | undefined;
    if (target.session === null) {
      detail = 'the session is gone';
    } else {
      try {
        dismissed = await this.options.cards.dismissDialog(
          target.session,
          args.dialogId,
        );
        if (!dismissed) detail = `the pane does not show ${args.dialogId}`;
      } catch (error) {
        this.options.log.warn('steward: a dismiss failed', {
          error: errorMessage(error),
        });
        detail = 'sending the key failed';
      }
    }
    this.acted(
      args.projectId,
      target.envelope,
      args.subject,
      'dismiss',
      dismissed,
      detail,
    );
    return { dismissed };
  }

  async resume(args: CardResumeArgs): Promise<CardResumeResult> {
    this.stewardOn(args.projectId);
    const subject: StewardActableSubject = {
      kind: 'card_round',
      cardId: args.cardId,
      runId: args.runId,
    };
    const record = this.options.cards.record(args.cardId);
    const envelope = record ? { repo: record.repo, root: record.root } : null;
    this.count(subject, 'resume');
    let result: CardResumeResult;
    try {
      result = await this.options.cards.resume(args);
    } catch (error) {
      if (envelope) {
        this.acted(
          args.projectId,
          envelope,
          subject,
          'resume',
          false,
          'the session could not be restarted',
        );
      }
      throw error;
    }
    if (envelope) {
      const detail =
        result.outcome === 'resumed'
          ? undefined
          : result.outcome === 'alive'
            ? 'the session was alive'
            : 'the worktree is gone';
      this.acted(
        args.projectId,
        envelope,
        subject,
        'resume',
        result.outcome === 'resumed',
        detail,
      );
    }
    if (result.outcome === 'resumed') this.options.onResumed?.(subject);
    return result;
  }

  private stewardOn(projectId: string): void {
    const projects = this.options.watchedProjects();
    if (!projects.some((p) => p.id === projectId)) {
      throw new CommandFailure(
        'path_not_allowed',
        `project ${projectId} is not watched by this runner`,
      );
    }
    if (!stewardConfigOf(projects, projectId)) {
      throw new CommandFailure(
        'unsupported',
        `Steward is off for project ${projectId}`,
      );
    }
  }

  /** The subject's session and envelope; `not_found` when it is not here. */
  private target(
    projectId: string,
    subject: StewardActableSubject,
  ): { session: string | null; envelope: StewardEnvelope } {
    if (subject.kind === 'card_round') {
      const record = this.options.cards.record(subject.cardId);
      if (!record || record.projectId !== projectId) {
        throw new CommandFailure(
          'not_found',
          `card ${subject.cardId} is not in ${projectId} on this runner`,
        );
      }
      if (record.runId !== subject.runId) {
        throw new CommandFailure(
          'not_found',
          `round ${subject.runId} is not card ${subject.cardId}'s current round`,
        );
      }
      return {
        session: this.options.cards.liveSession(
          projectId,
          subject.cardId,
          subject.runId,
        ),
        envelope: { repo: record.repo, root: record.root },
      };
    }
    const run = this.options.runs?.run(projectId, subject.runId) ?? null;
    if (!run) {
      throw new CommandFailure(
        'not_found',
        `run ${subject.runId} is not in ${projectId} on this runner`,
      );
    }
    return run;
  }

  /** Counts one attempt; past the per-round limit the command is refused. */
  private count(subject: StewardActableSubject, action: StewardAction): void {
    const max = LIMIT[action];
    if (max === undefined) return;
    const key = `${subjectKey(subject)}:${action}`;
    const done = this.attempts.get(key) ?? 0;
    if (done >= max) {
      throw new CommandFailure(
        'busy',
        `${action} is at its limit of ${max} for this round`,
      );
    }
    this.attempts.set(key, done + 1);
  }

  private acted(
    projectId: string,
    envelope: StewardEnvelope,
    subject: StewardActableSubject,
    action: StewardAction,
    ok: boolean,
    detail?: string,
  ): void {
    try {
      emitActed(this.options.emit, this.options.clock, envelope, {
        projectId,
        subject,
        action,
        result: ok ? 'ok' : 'failed',
        ...(detail ? { detail } : {}),
      });
    } catch (error) {
      this.options.log.warn('steward: an action record was not valid', {
        action,
        error: errorMessage(error),
      });
    }
  }
}
