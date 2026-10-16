import { statSync } from 'node:fs';
import {
  CARD_SESSION_POLL_MS,
  type StewardDialogId,
  type StewardIncidentKind,
  type StewardRunnerConfig,
  type StewardSubject,
} from '@agentdock/shared';
import {
  HOOK_STOPPED_EVENT,
  type UnsequencedEvent,
  type WatchedProject,
} from '@agentdock/shared/protocol';
import type { CardRecord } from '../cards/record';
import type { Cancel, Clock } from '../clock';
import type { ConfigProfile } from '../config';
import { errorMessage, type Logger } from '../log';
import type { StewardClassifier } from './classifier';
import { type StewardProjectConfig, stewardConfigOf } from './config';
import { emitObserved, type StewardEmit, type StewardEnvelope } from './emit';
import { paneTail, readPane } from './pane-rules';

/** What the observer needs of the card executor. */
export interface StewardCardSource {
  /** Every card record the executor keeps. */
  records(): readonly CardRecord[];
  /** The visible pane of a tmux session; null when it is gone. */
  capture(session: string): Promise<string | null>;
}

/** A runner run as the observer sees it: headless, so silence only. */
export interface StewardRun {
  runId: string;
  projectId: string;
  repo: string;
  root: string;
  startedAt?: string;
  /** `stream.jsonl`: the run's output, whose age is its silence. */
  streamFile: string;
}

export interface StewardRunSource {
  running(): readonly StewardRun[];
}

export interface StewardObserverOptions {
  cards: StewardCardSource;
  runs?: StewardRunSource;
  watchedProjects: () => readonly WatchedProject[];
  profiles: () => readonly ConfigProfile[];
  /** Absent: an unknown stall is reported as `silent`, unclassified. */
  classifier?: Pick<StewardClassifier, 'classify'>;
  emit: StewardEmit;
  clock: Clock;
  log: Logger;
  /** D6 open question: the runner's card poll by default. */
  pollMs?: number;
  /** A file's modification time in ms, or null; tests inject it. */
  mtime?: (path: string) => number | null;
}

/** What the observer remembers of one subject between polls. */
interface SubjectState {
  /** `kind|reason` of the last `steward.observed`; null once clear. */
  observed: string | null;
  /** The silence the classifier ran for (its start, ms); once per episode. */
  classifiedFor: number | null;
  classifying: boolean;
}

/** What the hooks said last of one Claude session. */
interface HookActivity {
  at: number;
  /** The last `hook.stopped`'s running background tasks (#390). */
  backgroundTasks: number;
}

const fileMtime = (path: string): number | null => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
};

const parseTime = (iso: string | undefined): number => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? t : 0;
};

/**
 * #447 D2, D6: the runner's half of Steward. Every poll it reads the pane of
 * each running card round of a project with Steward on, and the output age
 * of each running skill run, and reports a stall as `steward.observed` —
 * once per change of kind and reason for a subject, never on every poll. It
 * acts on nothing: nudge, dismiss and resume are the API's to decide and
 * arrive as commands (D4). A round the runner stopped is never observed;
 * fleet slots are not either (D5).
 */
export class StewardObserver {
  private readonly subjects = new Map<string, SubjectState>();
  private readonly hooks = new Map<string, HookActivity>();
  private readonly startedAt: number;
  private cancel: Cancel = () => {};
  private polling: Promise<void> | null = null;

  constructor(private readonly options: StewardObserverOptions) {
    this.startedAt = options.clock.now();
  }

  start(): void {
    this.cancel = this.options.clock.setInterval(
      () => void this.poll(),
      this.options.pollMs ?? CARD_SESSION_POLL_MS,
    );
  }

  stop(): void {
    this.cancel();
  }

  /**
   * Every event the hooks report, as the local service emits it: the
   * session's last activity, and at a stop its live background tasks.
   */
  hookSeen(event: Pick<UnsequencedEvent, 'type' | 'session' | 'data'>): void {
    const id = event.session?.id;
    if (!id || !event.type.startsWith('hook.')) return;
    const previous = this.hooks.get(id);
    let backgroundTasks = previous?.backgroundTasks ?? 0;
    if (event.type === HOOK_STOPPED_EVENT) {
      const data = event.data as { backgroundTasks?: unknown } | undefined;
      backgroundTasks =
        typeof data?.backgroundTasks === 'number' ? data.backgroundTasks : 0;
    }
    this.hooks.set(id, { at: this.options.clock.now(), backgroundTasks });
  }

  /**
   * D10: the executor found a running round's tmux session gone. Reported
   * as `dead_session`; whether to resume is the API's (it knows a finished
   * round from a crashed one).
   */
  sessionEnded(record: CardRecord, exitCode: number | null): void {
    const config = stewardConfigOf(
      this.options.watchedProjects(),
      record.projectId,
    );
    if (!config) return;
    this.report(
      this.cardKey(record),
      { repo: record.repo, root: record.root },
      record.projectId,
      { kind: 'card_round', cardId: record.cardId, runId: record.runId },
      {
        kind: 'dead_session',
        reason:
          exitCode === null
            ? "the card's session is gone"
            : `the card's session ended (exit code ${exitCode})`,
      },
    );
  }

  /** Forgets a round's state — a resumed session starts over. */
  forget(record: Pick<CardRecord, 'cardId' | 'runId'>): void {
    this.subjects.delete(this.cardKey(record));
  }

  /** One pass over every subject; a pass under way is joined. */
  poll(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.pollOnce().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    const projects = this.options.watchedProjects();
    const live = new Set<string>();
    for (const record of this.options.cards.records()) {
      if (record.phase !== 'running') continue;
      const config = stewardConfigOf(projects, record.projectId);
      if (!config) continue;
      const key = this.cardKey(record);
      live.add(key);
      try {
        await this.observeCard(record, config, key);
      } catch (error) {
        this.options.log.warn('steward: observing a card failed', {
          cardId: record.cardId,
          error: errorMessage(error),
        });
      }
    }
    for (const run of this.options.runs?.running() ?? []) {
      const config = stewardConfigOf(projects, run.projectId);
      if (!config) continue;
      const key = `run:${run.runId}`;
      live.add(key);
      this.observeRun(run, config, key);
    }
    for (const key of this.subjects.keys()) {
      if (!live.has(key)) this.subjects.delete(key);
    }
  }

  private async observeCard(
    record: CardRecord,
    config: StewardProjectConfig,
    key: string,
  ): Promise<void> {
    const text = await this.options.cards.capture(record.tmuxSession);
    // Gone: the executor's own poll reports it (`sessionEnded`).
    if (text === null) return;
    const envelope = { repo: record.repo, root: record.root };
    const subject: StewardSubject = {
      kind: 'card_round',
      cardId: record.cardId,
      runId: record.runId,
    };
    const tail = config.project.shipContent ? paneTail(text) : null;
    const reading = readPane(text);
    if (reading.signal) {
      this.report(
        key,
        envelope,
        record.projectId,
        subject,
        reading.signal,
        tail,
      );
      return;
    }
    const hook = record.sessionId
      ? this.hooks.get(record.sessionId)
      : undefined;
    const since = Math.max(
      hook?.at ?? 0,
      parseTime(record.startedAt),
      this.startedAt,
    );
    const threshold = config.silenceMinutes * 60_000;
    const now = this.options.clock.now();
    // #390: a live background task is work, not silence; #473: a question
    // waits for the person, whom the Board tells.
    if (
      (hook?.backgroundTasks ?? 0) > 0 ||
      reading.state === 'question' ||
      now - since < threshold
    ) {
      this.clear(key);
      return;
    }
    if (reading.state === 'idle') {
      this.report(
        key,
        envelope,
        record.projectId,
        subject,
        {
          kind: 'silent',
          reason: `waiting at the prompt, no activity for ${config.silenceMinutes}+ min`,
        },
        tail,
      );
      return;
    }
    this.classify(key, envelope, record, subject, text, since, config, tail);
  }

  /**
   * D3: a silent session that is not at its prompt and that no rule
   * explains — haiku says why, once per silent episode. The call takes
   * seconds, so the poll does not wait; a hook event meanwhile ends the
   * episode and the answer is dropped.
   */
  private classify(
    key: string,
    envelope: StewardEnvelope,
    record: CardRecord,
    subject: StewardSubject,
    text: string,
    since: number,
    config: StewardRunnerConfig,
    tail: string | null,
  ): void {
    const state = this.state(key);
    if (state.classifying || state.classifiedFor === since) return;
    const fallback = {
      kind: 'silent' as const,
      reason: `no hook event for ${config.silenceMinutes}+ min while the session is not at its prompt`,
    };
    const profile = record.profileKey
      ? this.options.profiles().find((p) => p.id === record.profileKey)
      : undefined;
    const classifier = this.options.classifier;
    const local = paneTail(text);
    if (!classifier || !profile || !local) {
      state.classifiedFor = since;
      this.report(key, envelope, record.projectId, subject, fallback, tail);
      return;
    }
    state.classifying = true;
    void classifier
      .classify(profile, record.projectId, local, config.silenceMinutes)
      .then((result) => {
        state.classifying = false;
        state.classifiedFor = since;
        const hook = record.sessionId
          ? this.hooks.get(record.sessionId)
          : undefined;
        // A hook event since: the session moved, the answer is stale.
        if ((hook?.at ?? 0) > since) return;
        if (!result) {
          this.report(key, envelope, record.projectId, subject, fallback, tail);
          return;
        }
        this.report(
          key,
          envelope,
          record.projectId,
          subject,
          { kind: 'unknown', reason: result.reason },
          tail,
          result.sessionId,
        );
      });
  }

  private observeRun(
    run: StewardRun,
    config: StewardRunnerConfig,
    key: string,
  ): void {
    const mtime = (this.options.mtime ?? fileMtime)(run.streamFile);
    const since = Math.max(
      mtime ?? 0,
      parseTime(run.startedAt),
      this.startedAt,
    );
    if (this.options.clock.now() - since < config.silenceMinutes * 60_000) {
      this.clear(key);
      return;
    }
    this.report(
      key,
      { repo: run.repo, root: run.root },
      run.projectId,
      { kind: 'run', runId: run.runId },
      {
        kind: 'silent',
        reason: `the run has written no output for ${config.silenceMinutes}+ min`,
      },
    );
  }

  /** Sends `steward.observed` when kind or reason changed since the last. */
  private report(
    key: string,
    envelope: StewardEnvelope,
    projectId: string,
    subject: StewardSubject,
    signal: {
      kind: StewardIncidentKind;
      reason: string;
      dialogId?: StewardDialogId;
    },
    tail?: string | null,
    classifierSessionId?: string,
  ): void {
    const state = this.state(key);
    const observed = `${signal.kind}|${signal.reason}`;
    if (state.observed === observed) return;
    try {
      emitObserved(this.options.emit, this.options.clock, envelope, {
        projectId,
        subject,
        kind: signal.kind,
        reason: signal.reason,
        ...(signal.kind === 'dialog' && signal.dialogId
          ? { dialogId: signal.dialogId }
          : {}),
        ...(tail ? { paneTail: tail } : {}),
        ...(classifierSessionId ? { classifierSessionId } : {}),
      });
      state.observed = observed;
    } catch (error) {
      this.options.log.warn('steward: an observation was not valid', {
        projectId,
        kind: signal.kind,
        error: errorMessage(error),
      });
    }
  }

  private clear(key: string): void {
    const state = this.subjects.get(key);
    if (state) {
      state.observed = null;
      state.classifiedFor = null;
    }
  }

  private state(key: string): SubjectState {
    let state = this.subjects.get(key);
    if (!state) {
      state = { observed: null, classifiedFor: null, classifying: false };
      this.subjects.set(key, state);
    }
    return state;
  }

  private cardKey(record: Pick<CardRecord, 'cardId' | 'runId'>): string {
    return `card:${record.cardId}:${record.runId}`;
  }
}
