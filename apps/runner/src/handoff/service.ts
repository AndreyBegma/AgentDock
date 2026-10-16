import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CARD_PR_DESCRIPTION_FILE,
  HANDOFF_UPDATED_EVENT,
  type HandoffLineRange,
  type HandoffUpdatedBy,
  handoffUpdatedDataSchema,
  ROUND_RESTART_EVENT,
  ROUND_WARMUP_EVENT,
  roundRestartDataSchema,
  roundWarmupDataSchema,
} from '@agentdock/shared';
import {
  type CardHandoffSetArgs,
  type CardHandoffSetResult,
  type CardRunArgs,
  HOOK_PRE_COMPACT_EVENT,
  HOOK_SESSION_STARTED_EVENT,
  HOOK_STOPPED_EVENT,
  HOOK_TOOL_FINISHED_EVENT,
  type UnsequencedEvent,
  type WatchedProject,
} from '@agentdock/shared/protocol';
import { isoNow } from '../clock';
import type { ConfigProfile } from '../config';
import { claudeConfigDir } from '../detect/profiles';
import { errorMessage, type Logger } from '../log';
import type { SkillsDeps } from '../skills/deps';
import { HANDOFF_REFRESH_TEXT } from './context';
import type { HandoffWriter } from './haiku';
import {
  judgeNote,
  type NoteReading,
  noteFileText,
  readNote,
  readNoteFile,
} from './note';
import { decideRestart, type RestartDecision } from './restart';
import { acceptanceChecklist, branchDiff, freshSeed, seedTokens } from './seed';
import {
  cardNumberOfPrompt,
  type HandoffStateStore,
  handoffNotePath,
  keepSession,
  type StoredNote,
} from './state';
import {
  FILE_EDIT_TOOLS,
  findTranscript,
  readTranscript,
  transcriptExcerpt,
  transcriptStats,
  warmupTokens,
} from './transcript';

export { HANDOFF_REFRESH_TEXT };

/** How often a message is tried at the prompt before it waits for the next stop. */
const PROMPT_TRIES = 3;
const PROMPT_RETRY_MS = 2_000;

/** What the service needs of a card round: the executor's record. */
export interface HandoffCard {
  cardId: string;
  projectId: string;
  repo: string;
  root: string;
  shortId: string;
  worktree: string;
  base: string;
  runId: string;
  phase: string;
  sessionId?: string;
  profileKey?: string;
  startedAt: string;
  tmuxSession: string;
}

export interface HandoffServiceOptions {
  deps: Pick<
    SkillsDeps,
    'exec' | 'clock' | 'home' | 'profiles' | 'watchedProjects'
  >;
  state: HandoffStateStore;
  /** The card's current round, as the executor keeps it. */
  record: (cardId: string) => HandoffCard | null;
  records: () => HandoffCard[];
  /** The round's session, when its prompt is idle; false when nothing was typed. */
  typeAtPrompt: (tmuxSession: string, text: string) => Promise<boolean>;
  writer: HandoffWriter;
  emit: (event: UnsequencedEvent) => void;
  log: Logger;
}

/** D3: how a round launches, and what to report once it did. */
export interface PreparedRound {
  launch: Pick<CardRunArgs, 'session' | 'prompt'>;
  restart:
    | { mode: 'first' }
    | (RestartDecision & { previousSessionId?: string });
}

const sleep = (deps: HandoffServiceOptions['deps'], ms: number) =>
  new Promise<void>((resolve) => deps.clock.setTimeout(resolve, ms));

/** Whether Context handoff is on for a launch: with Token saver (spec, Configuration). */
export const handoffOn = (args: Pick<CardRunArgs, 'tokenSaver'>): boolean =>
  args.tokenSaver?.enabled === true;

/**
 * Context handoff on the runner (#449, ADR-0042): the note's lifecycle for
 * card rounds — the agent's note validated at each stop, one refresh request
 * for a stale one, haiku for a dead session, a person's edit applied — the
 * restart decision, and the warm-up. Every event is built here, from the
 * executor's record (DA-04); note content leaves only for a project that
 * ships content (D4, DA-12, ADR-0021). One operation per card at a time.
 */
export class HandoffService {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly options: HandoffServiceOptions) {}

  /**
   * D3, before a round launches (Token saver on): round 1 keeps its prompt
   * for later fresh starts; a later round resumes or starts fresh by the
   * cheaper first turn. The session it does not resume stays recorded.
   */
  async prepareRound(
    card: HandoffCard,
    args: Pick<CardRunArgs, 'session' | 'prompt' | 'profileKey'>,
    profile: ConfigProfile,
  ): Promise<PreparedRound> {
    const { state } = this.options;
    const asAsked = { session: args.session, prompt: args.prompt };
    if (!args.session.resume) {
      const number = cardNumberOfPrompt(args.prompt);
      try {
        state.saveCardPrompt(card.cardId, args.prompt);
      } catch (error) {
        this.warn('saving the card prompt failed', card, error);
      }
      this.startRound(card, args.session.id, number);
      return { launch: asAsked, restart: { mode: 'first' } };
    }
    const decision = await this.decide(card, args, profile);
    if (decision.mode === 'resume' || decision.seed === null) {
      this.startRound(card, args.session.id, null);
      return {
        launch: asAsked,
        restart: { mode: 'resume', estimate: decision.estimate },
      };
    }
    const sessionId = randomUUID();
    this.startRound(card, sessionId, null, args.session.id);
    return {
      launch: {
        session: { id: sessionId, resume: false },
        prompt: decision.seed,
      },
      restart: {
        mode: 'fresh',
        estimate: decision.estimate,
        previousSessionId: args.session.id,
      },
    };
  }

  /** `round.restart`, once the round's session is started (D3). */
  reportRestart(card: HandoffCard, prepared: PreparedRound): void {
    const at = isoNow(this.options.deps.clock);
    const { restart } = prepared;
    try {
      const data = roundRestartDataSchema.parse({
        projectId: card.projectId,
        cardId: card.cardId,
        runId: card.runId,
        at,
        mode: restart.mode,
        estimate: restart.mode === 'first' ? null : restart.estimate,
        sessionId: prepared.launch.session.id,
        ...(restart.mode === 'fresh' && restart.previousSessionId
          ? { previousSessionId: restart.previousSessionId }
          : {}),
      });
      this.send(card, ROUND_RESTART_EVENT, at, data);
    } catch (error) {
      this.warn('reporting the restart failed', card, error);
    }
  }

  /**
   * The daemon's hook tap: a stop of a running round's session checks its
   * note (D5, D8), and so does a compaction about to start (#494); its first
   * file edit ends the warm-up (D9).
   */
  hookSeen(event: Pick<UnsequencedEvent, 'type' | 'session' | 'data'>): void {
    const sessionId = event.session?.id;
    if (!sessionId) return;
    if (event.type === HOOK_STOPPED_EVENT) {
      const card = this.runningRound(sessionId);
      if (card) void this.serial(card.cardId, () => this.checkNote(card, true));
      return;
    }
    if (event.type === HOOK_PRE_COMPACT_EVENT) {
      const card = this.runningRound(sessionId);
      if (card) void this.serial(card.cardId, () => this.beforeCompact(card));
      return;
    }
    if (event.type === HOOK_SESSION_STARTED_EVENT) {
      const data = event.data as { source?: unknown } | undefined;
      if (data?.source !== 'compact') return;
      const card = this.runningRound(sessionId);
      if (card) void this.serial(card.cardId, () => this.afterCompact(card));
      return;
    }
    if (event.type === HOOK_TOOL_FINISHED_EVENT) {
      const data = event.data as { toolName?: unknown } | undefined;
      const tool = typeof data?.toolName === 'string' ? data.toolName : '';
      if (!FILE_EDIT_TOOLS.has(tool)) return;
      const card = this.runningRound(sessionId);
      if (card) void this.serial(card.cardId, () => this.warmup(card));
    }
  }

  /** D2: a round's session ended; a stale or missing note is written by haiku. */
  sessionEnded(card: HandoffCard): Promise<void> {
    if (!this.active(card)) return Promise.resolve();
    return this.serial(card.cardId, async () => {
      const reading = await this.checkNote(card, false);
      if (reading === 'fresh') return;
      await this.haikuNote(card);
    });
  }

  /** `card.handoff.set` (D7): a person's edit, written with their marks. */
  setFromPerson(args: CardHandoffSetArgs): Promise<CardHandoffSetResult> {
    return this.serial(args.cardId, async () => {
      // The worktree comes from the card's record, never from the command.
      const card = this.options.record(args.cardId);
      if (
        !card ||
        card.projectId !== args.projectId ||
        card.shortId !== args.shortId ||
        !existsSync(card.worktree)
      ) {
        return { outcome: 'no_worktree' as const };
      }
      this.writeNoteFile(handoffNotePath(card.worktree), args);
      this.store(card, args, 'person');
      return { outcome: 'applied' as const };
    });
  }

  /** Resolves once every operation queued so far settled (tests). */
  async settled(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains.values()]);
  }

  private async decide(
    card: HandoffCard,
    args: Pick<CardRunArgs, 'session' | 'prompt'>,
    profile: ConfigProfile,
  ): Promise<RestartDecision & { seed: string | null }> {
    const jsonl = this.transcriptOf(profile, args.session.id);
    const seed = await this.seed(card, args);
    const decision = decideRestart(
      jsonl
        ? transcriptStats(jsonl)
        : { historyTokens: 0, lastTurnAt: null, cache1h: false },
      seed === null ? null : seedTokens(seed),
      this.options.deps.clock.now(),
    );
    return { ...decision, seed };
  }

  /** D3: the fresh seed, or null when a fresh start is not possible. */
  private async seed(
    card: HandoffCard,
    args: Pick<CardRunArgs, 'session' | 'prompt'>,
  ): Promise<string | null> {
    const { state, deps } = this.options;
    const cardPrompt = state.cardPrompt(card.cardId);
    if (!cardPrompt) return null;
    const stored = this.currentNote(card);
    if (!stored) return null;
    const diff = await branchDiff(deps.exec, card.worktree, card.base);
    let description: string | null = null;
    try {
      description = readFileSync(
        join(card.worktree, CARD_PR_DESCRIPTION_FILE),
        'utf8',
      );
    } catch {
      description = null;
    }
    return freshSeed({
      cardPrompt,
      note: noteFileText(stored),
      diff,
      checklist: acceptanceChecklist(description),
      roundPrompt: args.prompt,
      previousSessionId: args.session.id,
    });
  }

  /** The stored note after taking in a valid one the agent left on disk. */
  private currentNote(card: HandoffCard): StoredNote | null {
    const stored = this.options.state.load(card.cardId).note;
    const reading = readNote(handoffNotePath(card.worktree), stored);
    if (reading.kind === 'accepted') {
      return this.store(card, reading, 'agent');
    }
    return stored;
  }

  private startRound(
    card: HandoffCard,
    sessionId: string,
    number: number | null,
    previousSessionId?: string,
  ): void {
    const { state, deps } = this.options;
    try {
      state.update(card.cardId, (s) => {
        if (number !== null) s.number = number;
        if (previousSessionId) keepSession(s, previousSessionId);
        keepSession(s, sessionId);
        s.warmup = {
          runId: card.runId,
          sessionId,
          startedAt: deps.clock.now(),
          reported: false,
        };
      });
      // A person's note written while no round ran is on disk already;
      // put the stored note back if the file lost it.
      const stored = state.load(card.cardId).note;
      if (stored) {
        const path = handoffNotePath(card.worktree);
        if (!readNoteFile(path)) this.writeNoteFile(path, stored);
      }
    } catch (error) {
      this.warn('recording the round failed', card, error);
    }
  }

  /**
   * D5, D8. Takes in a valid note the agent wrote; tells the agent once why
   * one was refused; asks once per round for a note older than the round's
   * last commit. With `alive: false` nothing is typed. Answers whether the
   * note is fresh afterwards.
   */
  private async checkNote(
    card: HandoffCard,
    alive: boolean,
  ): Promise<'fresh' | 'stale'> {
    const { state } = this.options;
    try {
      const path = handoffNotePath(card.worktree);
      const before = state.load(card.cardId);
      const reading = readNote(path, before.note);
      if (reading.kind === 'accepted') this.store(card, reading, 'agent');
      if (reading.kind === 'refused') {
        if (alive && before.refused !== reading.content) {
          if (await this.tell(card, reading.text)) {
            state.update(card.cardId, (s) => {
              s.refused = reading.content;
            });
          }
        }
        return 'stale';
      }
      if (!(await this.isStale(card, reading))) return 'fresh';
      if (alive && !before.asked.includes(card.runId)) {
        if (await this.tell(card, HANDOFF_REFRESH_TEXT)) {
          state.update(card.cardId, (s) => {
            s.asked.push(card.runId);
          });
        }
      }
      return 'stale';
    } catch (error) {
      this.warn('checking the note failed', card, error);
      return 'stale';
    }
  }

  /**
   * #494, D8: before a compaction. Claude Code's `PreCompact` cannot reach
   * the model and its prompt is busy compacting, so a stale note's one
   * request of the round is owed to the `SessionStart` after it (the hook
   * prints it with the note); the stop never asks again.
   */
  private async beforeCompact(card: HandoffCard): Promise<void> {
    const { state } = this.options;
    try {
      const before = state.load(card.cardId);
      if (before.asked.includes(card.runId)) return;
      const reading = readNote(handoffNotePath(card.worktree), before.note);
      if (reading.kind === 'accepted') this.store(card, reading, 'agent');
      // A refused note is told at the stop, with its reason.
      if (reading.kind === 'refused') return;
      if (!(await this.isStale(card, reading))) return;
      state.update(card.cardId, (s) => {
        s.asked.push(card.runId);
        s.compactAsk = card.runId;
      });
    } catch (error) {
      this.warn('checking the note before a compaction failed', card, error);
    }
  }

  /** #494: the session started after its compaction; the owed request went with it. */
  private async afterCompact(card: HandoffCard): Promise<void> {
    try {
      if (this.options.state.load(card.cardId).compactAsk === undefined) return;
      this.options.state.update(card.cardId, (s) => {
        s.compactAsk = undefined;
      });
    } catch (error) {
      this.warn('clearing the compaction request failed', card, error);
    }
  }

  /**
   * D8: the note is older than the round's last commit — or missing while
   * the round committed. A round that made no commit is never stale.
   */
  private async isStale(
    card: HandoffCard,
    reading: NoteReading,
  ): Promise<boolean> {
    const result = await this.options.deps.exec(
      'git',
      ['-C', card.worktree, 'log', '-1', '--format=%ct', 'HEAD'],
      { timeoutMs: 5_000 },
    );
    const seconds = Number(result?.code === 0 ? result.stdout.trim() : NaN);
    if (!Number.isFinite(seconds)) return false;
    const committedAt = seconds * 1000;
    // Commit times have one-second resolution: a commit in the round's first
    // second still counts.
    if (committedAt < Date.parse(card.startedAt) - 1000) return false;
    if (reading.kind === 'missing') return true;
    const file = readNoteFile(handoffNotePath(card.worktree));
    return !file || file.mtimeMs < committedAt;
  }

  /** D2: haiku writes the note from the dead session's transcript. */
  private async haikuNote(card: HandoffCard): Promise<void> {
    const { state, deps, writer } = this.options;
    const profile = deps.profiles().find((p) => p.id === card.profileKey);
    if (!profile || !card.sessionId) return;
    const jsonl = this.transcriptOf(profile, card.sessionId);
    if (!jsonl) return;
    const excerpt = transcriptExcerpt(jsonl);
    if (!excerpt) return;
    const stored = state.load(card.cardId).note;
    const written = await writer.write(
      profile,
      card.projectId,
      excerpt,
      stored ? noteFileText(stored) : null,
    );
    if (!written) return;
    const judged = judgeNote(written, stored);
    if (judged.kind !== 'accepted') {
      this.options.log.info('handoff: haiku wrote no valid note', {
        cardId: card.cardId,
        runId: card.runId,
        kind: judged.kind,
      });
      return;
    }
    this.writeNoteFile(handoffNotePath(card.worktree), judged);
    this.store(card, judged, 'haiku');
  }

  /** D9: tokens and ms from the round's start to its first file edit, once. */
  private async warmup(card: HandoffCard): Promise<void> {
    const { state, deps } = this.options;
    const current = state.load(card.cardId).warmup;
    if (
      !current ||
      current.reported ||
      current.runId !== card.runId ||
      current.sessionId !== card.sessionId
    ) {
      return;
    }
    const ms = Math.max(0, deps.clock.now() - current.startedAt);
    const profile = deps.profiles().find((p) => p.id === card.profileKey);
    const jsonl = profile
      ? this.transcriptOf(profile, current.sessionId)
      : null;
    // The hook can outrun the transcript's last line: then the whole round
    // so far is counted.
    const tokens = jsonl ? warmupTokens(jsonl, current.startedAt) : 0;
    state.update(card.cardId, (s) => {
      if (s.warmup) s.warmup.reported = true;
    });
    const at = isoNow(deps.clock);
    try {
      const data = roundWarmupDataSchema.parse({
        projectId: card.projectId,
        cardId: card.cardId,
        runId: card.runId,
        at,
        tokens: Math.min(tokens, 2_147_483_647),
        ms: Math.min(ms, 2_147_483_647),
      });
      this.send(card, ROUND_WARMUP_EVENT, at, data);
    } catch (error) {
      this.warn('reporting the warm-up failed', card, error);
    }
  }

  /** Stores an accepted note and reports it where content may go. */
  private store(
    card: HandoffCard,
    note: { content: string; personLines: HandoffLineRange[] },
    updatedBy: HandoffUpdatedBy,
  ): StoredNote {
    const at = isoNow(this.options.deps.clock);
    const stored: StoredNote = {
      content: note.content,
      personLines: note.personLines,
      updatedBy,
      updatedAt: at,
    };
    this.options.state.update(card.cardId, (s) => {
      s.note = stored;
      delete s.refused;
    });
    // The agent's file gets the runner's marks back (D7).
    if (updatedBy === 'agent' && note.personLines.length > 0) {
      this.writeNoteFile(handoffNotePath(card.worktree), note);
    }
    if (this.shipsContent(card)) {
      try {
        const data = handoffUpdatedDataSchema.parse({
          projectId: card.projectId,
          at,
          subject: { kind: 'card', cardId: card.cardId },
          updatedBy,
          content: note.content,
          personLines: note.personLines,
        });
        this.send(card, HANDOFF_UPDATED_EVENT, at, data);
      } catch (error) {
        this.warn('reporting the note failed', card, error);
      }
    }
    return stored;
  }

  /** D4, ADR-0021: only a project that ships content gets the note. */
  private shipsContent(card: HandoffCard): boolean {
    const project = this.options.deps
      .watchedProjects()
      .find(
        (p: WatchedProject) => p.id === card.projectId && p.root === card.root,
      );
    return project?.shipContent === true;
  }

  private writeNoteFile(
    path: string,
    note: { content: string; personLines: readonly HandoffLineRange[] },
  ): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, noteFileText(note));
  }

  private async tell(card: HandoffCard, text: string): Promise<boolean> {
    for (let i = 0; i < PROMPT_TRIES; i++) {
      if (i > 0) await sleep(this.options.deps, PROMPT_RETRY_MS);
      const current = this.options.record(card.cardId);
      if (!current || current.runId !== card.runId) return false;
      if (current.phase !== 'running') return false;
      try {
        if (await this.options.typeAtPrompt(card.tmuxSession, text)) {
          return true;
        }
      } catch (error) {
        this.warn('typing at the prompt failed', card, error);
        return false;
      }
    }
    return false;
  }

  /** A running round with Context handoff on (it was prepared by `prepareRound`). */
  private runningRound(sessionId: string): HandoffCard | null {
    const card = this.options
      .records()
      .find((r) => r.phase === 'running' && r.sessionId === sessionId);
    return card && this.active(card) ? card : null;
  }

  /** Whether `prepareRound` started this round — Context handoff is on for it. */
  private active(card: HandoffCard): boolean {
    return this.options.state.load(card.cardId).warmup?.runId === card.runId;
  }

  private transcriptOf(
    profile: ConfigProfile,
    sessionId: string,
  ): string | null {
    const projects = join(
      claudeConfigDir(profile, this.options.deps.home),
      'projects',
    );
    const path = findTranscript(projects, sessionId);
    return path ? readTranscript(path) : null;
  }

  private send(
    card: HandoffCard,
    type: string,
    at: string,
    data: unknown,
  ): void {
    this.options.emit({
      v: 1,
      ts: at,
      type,
      source: 'runner',
      project: { repo: card.repo, root: card.root },
      data,
    });
  }

  private warn(message: string, card: HandoffCard, error: unknown): void {
    this.options.log.warn(`handoff: ${message}`, {
      cardId: card.cardId,
      runId: card.runId,
      error: errorMessage(error),
    });
  }

  private serial<T>(cardId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(cardId) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    const settled = next.then(
      () => {},
      () => {},
    );
    this.chains.set(cardId, settled);
    void settled.then(() => {
      if (this.chains.get(cardId) === settled) this.chains.delete(cardId);
    });
    return next;
  }
}
