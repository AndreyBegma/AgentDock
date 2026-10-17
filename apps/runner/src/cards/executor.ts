import { existsSync } from 'node:fs';
import {
  AGENTDOCK_WORKTREE_DIR,
  CARD_PUSH_MIN_INTERVAL_MS,
  CARD_SESSION_POLL_MS,
  STEWARD_RESUME_TEXT,
} from '@agentdock/shared';
import {
  type CardCloseArgs,
  type CardCloseResult,
  type CardCollectArgs,
  type CardCollectResult,
  type CardResumeArgs,
  type CardResumeResult,
  type CardRunArgs,
  type CardRunPhase,
  type CardRunPhaseChangedData,
  type CardRunResult,
  type CardStopArgs,
  type CardStopResult,
  cardRunPendingQuestionDataSchema,
  cardRunPhaseChangedDataSchema,
  cardRunPushedDataSchema,
  cardRunQuestionDataSchema,
  cardSessionName,
  type UnsequencedEvent,
} from '@agentdock/shared/protocol';
import { type Cancel, isoNow } from '../clock';
import { CommandFailure } from '../commands/failure';
import type { ConfigProfile } from '../config';
import { projectCheckout, watchedProject } from '../control/target';
import { TmuxControl } from '../control/tmux';
import { resolveFleetProject } from '../fleet/project';
import {
  type HandoffService,
  handoffOn,
  type PreparedRound,
} from '../handoff/service';
import type { SessionBinding } from '../local/session-tokens';
import { errorMessage, type Logger } from '../log';
import { type DeliveryTmux, deliverText } from '../session/deliver';
import { profileOf, type SkillsDeps } from '../skills/deps';
import { RUN_FILES, writeJsonAtomic } from '../skills/run/record';
import { type StewardProjectConfig, stewardConfigOf } from '../steward/config';
import { emitActed, emitObserved } from '../steward/emit';
import { readPane } from '../steward/pane-rules';
import { type AttachmentSource, syncAttachments } from './attachments';
import { answerDialog, KNOWN_DIALOGS, matchKnownDialog } from './dialogs';
import {
  collectBranch,
  collectCard,
  commitFiles,
  ensureWorktree,
  excludeFromGit,
  removeCardWorktree,
  startFollowUpBranch,
} from './git';
import { cardLaunchSpec, cardTokenSaver, cardWorktreePath } from './launch';
import { type PushStep, pushCardHead } from './push';
import { matchQuestion, readQuestion } from './question';
import { type CardRecord, CardStore } from './record';
import {
  heldDetail,
  type TrailerCommit,
  TrailerHeld,
  trailerMessage,
} from './trailer-guard';
import { type CardWiring, wireCardRound } from './wiring';

export interface CardExecutorOptions {
  deps: SkillsDeps;
  /** `$XDG_STATE_HOME/agentdock/cards`, beside the runs. */
  cardsDir: string;
  /** The argv that starts this runner: `exec-run <roundDir>` is appended. */
  selfCommand: readonly string[];
  /** The tmux server: empty for the user's own, `['-L', name]` in tests. */
  tmuxServer?: readonly string[];
  emit: (event: UnsequencedEvent) => void;
  log: Logger;
  /** The OTLP receiver's bound port, null when it is off. */
  otlpPort?: () => number | null;
  pollMs?: number;
  /** #359 D1: `CARD_PUSH_MIN_INTERVAL_MS` unless a test sets it. */
  pushIntervalMs?: number;
  /**
   * Where `card.run` downloads attachments from (#309 D9): the API and the
   * runner token. Required: without it every card with an attachment fails
   * with `attachments_unavailable`.
   */
  attachmentSource: AttachmentSource;
  /** #447 D10: a running round's session was found gone (Steward observes it). */
  onSessionEnded?: (record: CardRecord, exitCode: number | null) => void;
  /** #449: Context handoff; absent, every round launches as the API asked. */
  handoff?: HandoffService;
  /** #113: the token a round's session presents to the local socket. */
  sessionToken?: (binding: SessionBinding) => string;
}

/**
 * #359 D1/D8: what a new round's record keeps of the last one. The draft PR
 * is the round's own. On the same branch, what was pushed and the PR found
 * stay; on another branch (a follow-up), the last branch joins
 * `previousBranches` with the head pushed of it, for Completed's cleanup.
 */
const pushStateOf = (
  previous: CardRecord | null,
  args: CardRunArgs,
): Pick<
  CardRecord,
  'pullRequest' | 'pushedHead' | 'pushPr' | 'previousBranches'
> => {
  const pullRequest = args.pullRequest ? { pullRequest: args.pullRequest } : {};
  if (!previous) return pullRequest;
  if (previous.branch === args.branch) {
    return {
      ...pullRequest,
      ...(previous.pushedHead ? { pushedHead: previous.pushedHead } : {}),
      ...(previous.pushPr ? { pushPr: previous.pushPr } : {}),
      ...(previous.previousBranches
        ? { previousBranches: previous.previousBranches }
        : {}),
    };
  }
  const earlier = (previous.previousBranches ?? []).filter(
    (b) => b.branch !== previous.branch && b.branch !== args.branch,
  );
  return {
    ...pullRequest,
    previousBranches: [
      ...earlier,
      {
        branch: previous.branch,
        ...(previous.pushedHead ? { pushedHead: previous.pushedHead } : {}),
      },
    ],
  };
};

/** An event's `error`: one line, at most 500 characters, no stack. */
const eventError = (error: unknown): string =>
  (errorMessage(error).split('\n')[0] || 'the round could not start').slice(
    0,
    500,
  );

/**
 * Board card workers (issue #242 D5–D10, ADR-0024). Each card has its own
 * worktree and tmux session `agentdock-card-<shortId>`, where `exec-run`
 * starts an interactive Claude Code session — a person can attach and type.
 * Outside the orchestrator and outside the skill-run cap: the API limits
 * running cards per project (D13). A round outlives `card.run`; the session
 * ending is reported as `card_run.phase_changed {phase: 'ended'}`, polled
 * every `CARD_SESSION_POLL_MS`. State lives in `cardsDir`, so a restart keeps
 * watching the sessions that ran on in tmux.
 */
export class CardExecutor {
  readonly store: CardStore;
  private readonly tmux: TmuxControl;
  /** One operation per card at a time; `poll` skips a card that is busy. */
  private readonly chains = new Map<string, Promise<unknown>>();
  private polling: Promise<void> | null = null;
  private cancelPoll: Cancel = () => {};
  /** #359 D1: when a card's last push step reached the network, per card. */
  private readonly lastPushAt = new Map<string, number>();
  /** #447 D7: the held head (`runId:sha`) last reported, per card. */
  private readonly heldReported = new Map<string, string>();
  /** #447 D7: the held head the worker was last told of, per card. */
  private readonly heldTold = new Map<string, string>();
  /** #473: the question (`runId:key`) last reported on screen, per card. */
  private readonly questionShown = new Map<string, string>();
  /** #489: the selector screen (`runId:key`) last reported, per card. */
  private readonly pendingShown = new Map<string, string>();

  constructor(private readonly options: CardExecutorOptions) {
    this.store = new CardStore(options.cardsDir);
    this.tmux = new TmuxControl(options.deps.exec, options.tmuxServer ?? []);
  }

  /** Settles rounds a previous runner left mid-start, then starts polling. */
  async start(): Promise<void> {
    for (const record of this.store.all()) {
      if (record.phase !== 'starting') continue;
      if (await this.tmux.find(record.tmuxSession)) {
        this.setPhase(record, 'running');
      } else {
        this.setPhase(record, 'failed', {
          error: 'the runner restarted while the round was starting',
        });
      }
    }
    this.cancelPoll = this.options.deps.clock.setInterval(
      () => void this.poll(),
      this.options.pollMs ?? CARD_SESSION_POLL_MS,
    );
  }

  /** Stops polling. The sessions keep running; the next start watches them again. */
  stop(): void {
    this.cancelPoll();
  }

  /** The card's tmux session, when the card is this project's (terminal target). */
  cardSession(projectId: string, root: string, cardId: string): string | null {
    const record = this.store.load(cardId);
    return record && record.projectId === projectId && record.root === root
      ? record.tmuxSession
      : null;
  }

  /** `card.run` (D5, D9). Answers once the session is started. */
  async run(args: CardRunArgs): Promise<CardRunResult> {
    const profile = profileOf(this.options.deps, args.profileKey);
    if (profile.runtime !== 'claude') {
      throw new CommandFailure(
        'unsupported_runtime',
        `card workers need a claude profile; ${profile.id} is ${profile.runtime}`,
      );
    }
    const project = watchedProject(args, this.options.deps.watchedProjects());
    this.ownedOrAbsent(args.cardId, args.projectId);
    return this.serial(args.cardId, async () => {
      const { deps } = this.options;
      const fleet = await resolveFleetProject(deps.exec, project);
      const tmuxSession = cardSessionName(args.shortId);
      const previous = this.store.load(args.cardId);
      // D9: a session still open from the last round is replaced; its end is
      // the runner's own doing, so it is not reported as `ended`.
      if (previous && previous.phase !== 'stopped') {
        this.setPhase(previous, 'stopped');
      }
      await this.kill(tmuxSession);
      const record: CardRecord = {
        cardId: args.cardId,
        projectId: args.projectId,
        root: project.root,
        repo: fleet.repo,
        shortId: args.shortId,
        worktree: cardWorktreePath(project.root, args.shortId),
        branch: args.branch,
        base: args.base,
        tmuxSession,
        runId: args.runId,
        phase: 'starting',
        sessionId: args.session.id,
        profileKey: args.profileKey,
        startedAt: isoNow(deps.clock),
        // #359 D3: the spec (and design) the PR links; only round 1 sends them.
        specFiles: args.files?.length
          ? args.files.map((f) => f.path)
          : previous?.specFiles,
        ...pushStateOf(previous, args),
      };
      this.setPhase(record, 'starting');
      let wiring: CardWiring;
      let prepared: PreparedRound | null = null;
      try {
        // #359 D8: the follow-up branch, from the updated base, first.
        if (args.newBranch) await startFollowUpBranch(deps, record);
        await ensureWorktree(deps, record);
        // #359 D3: the worker's PR description goes under `.agentdock/`,
        // excluded whether or not the card has attachments.
        await excludeFromGit(
          deps,
          record.worktree,
          `${AGENTDOCK_WORKTREE_DIR}/`,
        );
        // #309 D9: before the session starts or resumes; a file that cannot
        // be had fails the command with `attachments_unavailable`.
        await syncAttachments(
          deps,
          record.worktree,
          args.attachments ?? [],
          this.options.attachmentSource,
        );
        await commitFiles(deps, record.worktree, args.files ?? []);
        const roundDir = this.store.createRound(record.cardId, record.runId);
        // #367 D1, D2: hooks and `finish_card` without per-profile setup.
        wiring = wireCardRound(
          profile,
          deps.home,
          roundDir,
          this.options.selfCommand,
        );
        if (wiring.wiring === 'none') {
          this.options.log.warn('cards: the round starts without wiring', {
            cardId: record.cardId,
            runId: record.runId,
            reason: wiring.wiringReason,
          });
        }
        // #449 D3: with Token saver on, resume or a fresh seeded session.
        prepared = await this.prepareHandoff(record, args, profile);
        const launch = prepared ? { ...args, ...prepared.launch } : args;
        record.sessionId = launch.session.id;
        // #445: off or absent launches exactly as before.
        const tokenSaver = cardTokenSaver(
          profile,
          launch,
          deps.home,
          roundDir,
          this.options.selfCommand,
          wiring,
        );
        writeJsonAtomic(
          `${roundDir}/${RUN_FILES.launch}`,
          cardLaunchSpec(
            profile,
            launch,
            record.worktree,
            this.options.otlpPort?.() ?? null,
            wiring.files,
            tokenSaver,
            this.options.sessionToken?.({
              sessionId: launch.session.id,
              cwd: record.worktree,
            }),
          ),
        );
        const created = await this.tmux.newSession(
          tmuxSession,
          record.worktree,
          [...this.options.selfCommand, 'exec-run', roundDir],
        );
        if (!created.ok) {
          throw new Error(`tmux new-session failed: ${created.stderr}`);
        }
      } catch (error) {
        this.options.log.warn('cards: a round failed to start', {
          cardId: record.cardId,
          runId: record.runId,
          error: errorMessage(error),
        });
        this.setPhase(record, 'failed', { error: eventError(error) });
        // A plain error is answered `internal`, with this one line.
        if (error instanceof CommandFailure) throw error;
        throw new Error(eventError(error));
      }
      this.setPhase(record, 'running', {
        wiring: wiring.wiring,
        ...(wiring.wiringReason ? { wiringReason: wiring.wiringReason } : {}),
      });
      if (prepared) this.options.handoff?.reportRestart(record, prepared);
      return { phase: 'running', tmuxSession };
    });
  }

  /**
   * #449 D3: how a round with Context handoff on launches. Never fails the
   * round: a decision that cannot be made launches as the API asked.
   */
  private async prepareHandoff(
    record: CardRecord,
    args: CardRunArgs,
    profile: ConfigProfile,
  ): Promise<PreparedRound | null> {
    const { handoff } = this.options;
    if (!handoff || !handoffOn(args)) return null;
    try {
      return await handoff.prepareRound(record, args, profile);
    } catch (error) {
      this.options.log.warn('cards: the handoff restart decision failed', {
        cardId: record.cardId,
        runId: record.runId,
        error: errorMessage(error),
      });
      return null;
    }
  }

  /** `card.stop`: kills the card's session; its round is the API's to close. */
  async stopCard(args: CardStopArgs): Promise<CardStopResult> {
    this.ownedOrAbsent(args.cardId, args.projectId);
    return this.serial(args.cardId, async () => {
      const record = this.store.load(args.cardId);
      if (!record) return { stopped: false };
      const alive = (await this.tmux.find(record.tmuxSession)) !== null;
      if (record.phase !== 'stopped') this.setPhase(record, 'stopped');
      if (alive) await this.kill(record.tmuxSession);
      return { stopped: alive };
    });
  }

  /** `card.collect` (D8). The session may still be open: its work so far is collected. */
  async collect(args: CardCollectArgs): Promise<CardCollectResult> {
    const project = watchedProject(args, this.options.deps.watchedProjects());
    // #447 D7: the trailer guard holds the push and the PR.
    const guard = {
      trailerGuard: this.steward(args.projectId)?.trailerGuard === true,
    };
    const { cwd } = args;
    if (cwd !== undefined) {
      // #282 D3: a terminal card has no worktree here — its session's
      // checkout is collected, once `cwd` is proven to be the project's.
      return this.serial(args.cardId, async () => {
        const { deps } = this.options;
        const worktree = await projectCheckout(deps.exec, project, cwd);
        return collectCard(
          deps,
          {
            projectId: args.projectId,
            root: project.root,
            worktree,
            branch: args.branch,
          },
          args,
          { ...guard, trackedOnly: true },
        );
      });
    }
    return this.serial(args.cardId, async () => {
      const { deps } = this.options;
      const record = this.store.load(args.cardId);
      if (
        record &&
        (record.projectId !== args.projectId || record.root !== args.root)
      ) {
        throw new CommandFailure(
          'not_found',
          'the card belongs to another project on this runner',
        );
      }
      // #344: Accept's `card.close` removed the worktree and the record; the
      // branch it kept is collected from a temporary worktree.
      if (!record || !existsSync(record.worktree)) {
        return collectBranch(
          deps,
          {
            projectId: args.projectId,
            root: project.root,
            branch: args.branch,
          },
          args,
          guard,
        );
      }
      if (record.branch !== args.branch) {
        throw new CommandFailure(
          'invalid_args',
          `card ${args.cardId} works on ${record.branch}, not ${args.branch}`,
        );
      }
      try {
        return await collectCard(deps, record, args, guard);
      } catch (error) {
        if (error instanceof TrailerHeld) {
          const head = error.commits.at(-1)?.sha ?? 'collect';
          await this.holdPush(record, head, error.commits);
        }
        throw error;
      }
    });
  }

  /** `card.close` (D10): never merges; unpushed work keeps its branch. */
  async close(args: CardCloseArgs): Promise<CardCloseResult> {
    this.ownedOrAbsent(args.cardId, args.projectId);
    return this.serial(args.cardId, async () => {
      const record = this.store.load(args.cardId);
      if (!record) {
        return { stopped: false, worktreeRemoved: false, branchDeleted: false };
      }
      const alive = (await this.tmux.find(record.tmuxSession)) !== null;
      if (record.phase !== 'stopped') this.setPhase(record, 'stopped');
      if (alive) await this.kill(record.tmuxSession);
      if (!args.removeWorktree) {
        return { stopped: alive, worktreeRemoved: false, branchDeleted: false };
      }
      const removed = await removeCardWorktree(this.options.deps, record);
      this.store.remove(record.cardId);
      return { stopped: alive, ...removed };
    });
  }

  /**
   * D6 (2): reports every running session that is gone as `ended`; #359 D1:
   * queues a push step for every live one. A poll already under way is
   * joined, not repeated.
   */
  poll(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = this.pollOnce().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    for (const record of this.store.all()) {
      if (record.phase !== 'running' || this.chains.has(record.cardId))
        continue;
      if (await this.tmux.find(record.tmuxSession)) {
        const pane = await this.capturePane(record);
        // #447 D11: with Steward on, a dialog is the API's to dismiss (its
        // `autoDismiss` switch); Steward observes it.
        if (pane && !this.steward(record.projectId)) {
          await this.dismissKnownDialog(record, pane);
        }
        this.noticePendingQuestion(record, pane);
        this.noticeQuestion(record, pane);
        this.queuePush(record);
        continue;
      }
      // Re-read: an operation may have started while tmux answered, and a
      // push step may have finished since the list was read.
      if (this.chains.has(record.cardId)) continue;
      const current = this.store.load(record.cardId);
      if (!current || current.phase !== 'running') continue;
      const exit = this.store.exit(current);
      current.endedAt = isoNow(this.options.deps.clock);
      this.setPhase(
        current,
        'ended',
        exit?.code !== null && exit?.code !== undefined
          ? { exitCode: exit.code }
          : {},
      );
      this.options.onSessionEnded?.(current, exit?.code ?? null);
      // #449 D2: haiku writes a stale note of a dead session (off the poll).
      void this.options.handoff?.sessionEnded(current);
    }
  }

  /** #447: the project's Steward config, when Steward is on there. */
  private steward(projectId: string): StewardProjectConfig | null {
    return stewardConfigOf(this.options.deps.watchedProjects(), projectId);
  }

  /**
   * #447 D10: `card.resume`. The round's dead session restarts in its own
   * worktree with `claude --resume <sessionId>` and the fixed resume prompt,
   * on the launch facts the API sent — never a new worktree, never a round
   * the runner stopped (a person's stop, or replaced by a later round).
   */
  async resume(args: CardResumeArgs): Promise<CardResumeResult> {
    const profile = profileOf(this.options.deps, args.profileKey);
    if (profile.runtime !== 'claude') {
      throw new CommandFailure(
        'unsupported_runtime',
        `card workers need a claude profile; ${profile.id} is ${profile.runtime}`,
      );
    }
    const project = watchedProject(args, this.options.deps.watchedProjects());
    this.ownedOrAbsent(args.cardId, args.projectId);
    return this.serial(args.cardId, async () => {
      const { deps } = this.options;
      const record = this.store.load(args.cardId);
      if (
        !record ||
        record.runId !== args.runId ||
        record.root !== project.root ||
        record.shortId !== args.shortId ||
        record.branch !== args.branch
      ) {
        throw new CommandFailure(
          'not_found',
          `round ${args.runId} of card ${args.cardId} is not on this runner`,
        );
      }
      if (record.phase !== 'ended' && record.phase !== 'running') {
        throw new CommandFailure(
          'not_found',
          `round ${args.runId} is ${record.phase}; only a dead session is resumed`,
        );
      }
      if (await this.tmux.find(record.tmuxSession)) {
        return { outcome: 'alive', tmuxSession: record.tmuxSession };
      }
      if (!existsSync(record.worktree)) return { outcome: 'no_worktree' };
      const launch = {
        ...args,
        session: { id: args.sessionId, resume: true },
        prompt: STEWARD_RESUME_TEXT,
      };
      try {
        const roundDir = this.store.createRound(record.cardId, record.runId);
        const wiring = wireCardRound(
          profile,
          deps.home,
          roundDir,
          this.options.selfCommand,
        );
        const tokenSaver = cardTokenSaver(
          profile,
          launch,
          deps.home,
          roundDir,
          this.options.selfCommand,
          wiring,
        );
        writeJsonAtomic(
          `${roundDir}/${RUN_FILES.launch}`,
          cardLaunchSpec(
            profile,
            launch,
            record.worktree,
            this.options.otlpPort?.() ?? null,
            wiring.files,
            tokenSaver,
            this.options.sessionToken?.({
              sessionId: launch.session.id,
              cwd: record.worktree,
            }),
          ),
        );
        const created = await this.tmux.newSession(
          record.tmuxSession,
          record.worktree,
          [...this.options.selfCommand, 'exec-run', roundDir],
        );
        if (!created.ok) {
          throw new Error(`tmux new-session failed: ${created.stderr}`);
        }
        record.sessionId = args.sessionId;
        record.profileKey = args.profileKey;
        if (args.pullRequest) record.pullRequest = args.pullRequest;
        delete record.endedAt;
        this.setPhase(record, 'running', {
          wiring: wiring.wiring,
          ...(wiring.wiringReason ? { wiringReason: wiring.wiringReason } : {}),
        });
      } catch (error) {
        this.options.log.warn('cards: a round could not be resumed', {
          cardId: record.cardId,
          runId: record.runId,
          error: errorMessage(error),
        });
        if (error instanceof CommandFailure) throw error;
        throw new Error(eventError(error));
      }
      return { outcome: 'resumed', tmuxSession: record.tmuxSession };
    });
  }

  /**
   * The round's live tmux session, when `cardId`'s current round is `runId`
   * of `projectId` and runs — what a Steward command acts on (#447).
   */
  liveSession(projectId: string, cardId: string, runId: string): string | null {
    const record = this.store.load(cardId);
    return record &&
      record.projectId === projectId &&
      record.runId === runId &&
      record.phase === 'running'
      ? record.tmuxSession
      : null;
  }

  /** The visible pane of a card session; null when it is gone (#447). */
  capture(session: string): Promise<string | null> {
    return this.tmux.capture(session);
  }

  /**
   * Types one line into the round's session and submits it — only when the
   * pane shows an empty, idle prompt (#447 D7, D9). False when it does not,
   * or the session is gone: nothing was typed.
   */
  async typeAtPrompt(session: string, text: string): Promise<boolean> {
    return (
      (await deliverText(this.tmux, session, text, { idleOnly: true })) ===
      'sent'
    );
  }

  /** #489: the tmux calls a person's message to a card session makes. */
  get sessionTmux(): DeliveryTmux {
    return this.tmux;
  }

  /**
   * #447 D11: sends the listed dialog's key — only when the pane shows that
   * very dialog and no permission prompt. False otherwise: nothing was sent.
   */
  async dismissDialog(session: string, dialogId: string): Promise<boolean> {
    const pane = await this.tmux.capture(session);
    if (pane === null) return false;
    const reading = readPane(pane);
    if (
      reading.signal?.kind !== 'dialog' ||
      reading.signal.dialogId !== dialogId
    ) {
      return false;
    }
    const dialog = KNOWN_DIALOGS.find((d) => d.name === dialogId);
    if (!dialog) return false;
    return answerDialog(
      this.options.deps.exec,
      this.options.tmuxServer ?? [],
      session,
      dialog,
    );
  }

  /**
   * #447 D7: the trailer guard held a push of `record`'s round. Reported
   * once per held head — `steward.observed trailer` and `steward.acted
   * hold_push` — and the worker is told which commits, at its prompt, once
   * per head (tried again on later polls until it is at the prompt).
   */
  private async holdPush(
    record: CardRecord,
    headSha: string,
    held: readonly TrailerCommit[],
  ): Promise<void> {
    const { emit, deps } = this.options;
    const envelope = { repo: record.repo, root: record.root };
    const subject = {
      kind: 'card_round' as const,
      cardId: record.cardId,
      runId: record.runId,
    };
    const heldKey = `${record.runId}:${headSha}`;
    if (this.heldReported.get(record.cardId) !== heldKey) {
      this.heldReported.set(record.cardId, heldKey);
      try {
        emitObserved(emit, deps.clock, envelope, {
          projectId: record.projectId,
          subject,
          kind: 'trailer',
          reason: `the push is held: ${heldDetail(held)} with a Claude trailer`,
        });
        emitActed(emit, deps.clock, envelope, {
          projectId: record.projectId,
          subject,
          action: 'hold_push',
          result: 'ok',
          detail: heldDetail(held),
        });
      } catch (error) {
        this.options.log.warn('cards: reporting a held push failed', {
          cardId: record.cardId,
          error: errorMessage(error),
        });
      }
    }
    if (this.heldTold.get(record.cardId) === heldKey) return;
    try {
      if (await this.typeAtPrompt(record.tmuxSession, trailerMessage(held))) {
        this.heldTold.set(record.cardId, heldKey);
      }
    } catch (error) {
      this.options.log.warn('cards: telling the worker of a held push failed', {
        cardId: record.cardId,
        error: errorMessage(error),
      });
    }
  }

  /**
   * #435: answers a known blocking dialog that needs no decision (see
   * `KNOWN_DIALOGS`) with the option that changes nothing. Never fails the
   * poll; permission prompts and unknown dialogs are left alone.
   */
  private async dismissKnownDialog(
    record: CardRecord,
    pane: string,
  ): Promise<void> {
    try {
      const dialog = matchKnownDialog(pane);
      if (!dialog) return;
      const sent = await answerDialog(
        this.options.deps.exec,
        this.options.tmuxServer ?? [],
        record.tmuxSession,
        dialog,
      );
      const fields = { cardId: record.cardId, dialog: dialog.name };
      if (sent) {
        this.options.log.info('cards: dismissed a blocking dialog', fields);
      } else {
        this.options.log.warn('cards: could not dismiss a dialog', fields);
      }
    } catch (error) {
      this.options.log.warn('cards: answering a dialog failed', {
        cardId: record.cardId,
        error: errorMessage(error),
      });
    }
  }

  /** The visible pane of a live round; null when it cannot be read. */
  private async capturePane(record: CardRecord): Promise<string | null> {
    try {
      return await this.tmux.capture(record.tmuxSession);
    } catch (error) {
      this.options.log.warn('cards: capturing the pane failed', {
        cardId: record.cardId,
        error: errorMessage(error),
      });
      return null;
    }
  }

  /**
   * #489 M4: what the round's question selector shows — reported as
   * `card_run.pending_question` whenever the screen changes, and with
   * `question: null` once it is gone, so the Board can offer its options.
   * Content (ADR-0021): only for a project that ships it.
   */
  private noticePendingQuestion(record: CardRecord, pane: string | null): void {
    if (pane === null) return;
    const project = this.options.deps
      .watchedProjects()
      .find((p) => p.id === record.projectId);
    if (project?.shipContent !== true) return;
    const screen = readQuestion(pane);
    const shown = this.pendingShown.get(record.cardId);
    const key = screen ? `${record.runId}:${screen.question.key}` : null;
    if (
      key === null &&
      (shown === undefined || !shown.startsWith(`${record.runId}:`))
    ) {
      this.pendingShown.delete(record.cardId);
      return;
    }
    if (key !== null && shown === key) return;
    const at = isoNow(this.options.deps.clock);
    try {
      this.options.emit({
        v: 1,
        ts: at,
        type: 'card_run.pending_question',
        source: 'runner',
        project: { repo: record.repo, root: record.root },
        data: cardRunPendingQuestionDataSchema.parse({
          cardId: record.cardId,
          runId: record.runId,
          projectId: record.projectId,
          at,
          question: screen?.question ?? null,
        }),
      });
      if (key === null) this.pendingShown.delete(record.cardId);
      else this.pendingShown.set(record.cardId, key);
    } catch (error) {
      this.options.log.warn('cards: reporting a question screen failed', {
        cardId: record.cardId,
        error: errorMessage(error),
      });
    }
  }

  /**
   * #473: the worker asks the person a question (`AskUserQuestion`) —
   * reported as `card_run.question` once per question, when the poll first
   * sees it on screen. A pane without one forgets it, so the next question
   * is reported again; an unreadable pane changes nothing.
   */
  private noticeQuestion(record: CardRecord, pane: string | null): void {
    if (pane === null) return;
    const question = matchQuestion(pane);
    if (!question) {
      this.questionShown.delete(record.cardId);
      return;
    }
    const key = `${record.runId}:${question.key}`;
    if (this.questionShown.get(record.cardId) === key) return;
    this.questionShown.set(record.cardId, key);
    const at = isoNow(this.options.deps.clock);
    try {
      this.options.emit({
        v: 1,
        ts: at,
        type: 'card_run.question',
        source: 'runner',
        project: { repo: record.repo, root: record.root },
        data: cardRunQuestionDataSchema.parse({
          cardId: record.cardId,
          runId: record.runId,
          projectId: record.projectId,
          at,
        }),
      });
      this.options.log.info('cards: the worker asks a question', {
        cardId: record.cardId,
        runId: record.runId,
      });
    } catch (error) {
      this.questionShown.delete(record.cardId);
      this.options.log.warn('cards: reporting a question failed', {
        cardId: record.cardId,
        error: errorMessage(error),
      });
    }
  }

  /** Resolves once every card operation queued so far, pushes included, settled. */
  async settled(): Promise<void> {
    while (this.chains.size > 0) {
      await Promise.all([...this.chains.values()]);
    }
  }

  /**
   * #359 D1: queues a push step for a live round that asked for a draft PR,
   * on the card's chain — so it never interleaves with `run`, `collect` or
   * `close`, and the poll does not wait on the network. At most one step
   * that reached the network per `CARD_PUSH_MIN_INTERVAL_MS`; a failure is
   * logged and tried again after the interval, never failing the round.
   */
  private queuePush(record: CardRecord): void {
    if (!record.pullRequest) return;
    const { clock } = this.options.deps;
    const last = this.lastPushAt.get(record.cardId);
    const interval = this.options.pushIntervalMs ?? CARD_PUSH_MIN_INTERVAL_MS;
    if (last !== undefined && clock.now() - last < interval) return;
    void this.serial(record.cardId, async () => {
      // Re-read: the round may have been replaced or stopped meanwhile.
      const fresh = this.store.load(record.cardId);
      if (
        !fresh ||
        fresh.phase !== 'running' ||
        fresh.runId !== record.runId ||
        !existsSync(fresh.worktree)
      ) {
        return;
      }
      let step: PushStep | null;
      try {
        step = await pushCardHead(this.options.deps, fresh, {
          trailerGuard: this.steward(fresh.projectId)?.trailerGuard === true,
        });
      } catch (error) {
        this.lastPushAt.set(fresh.cardId, clock.now());
        this.options.log.warn('cards: pushing the round failed', {
          cardId: fresh.cardId,
          runId: fresh.runId,
          error: errorMessage(error),
        });
        return;
      }
      if (!step) return;
      this.lastPushAt.set(fresh.cardId, clock.now());
      if (step.held) {
        await this.holdPush(fresh, step.headSha, step.held);
        return;
      }
      if (step.prError) {
        this.options.log.warn('cards: opening the draft PR failed', {
          cardId: fresh.cardId,
          runId: fresh.runId,
          error: step.prError,
        });
      }
      fresh.pushedHead = step.headSha;
      if (step.pr) {
        fresh.pushPr = {
          number: step.pr.number,
          url: step.pr.url,
          opened: step.pr.opened,
        };
      }
      this.store.save(fresh);
      this.emitPushed(fresh, step);
    });
  }

  private emitPushed(record: CardRecord, step: PushStep): void {
    const at = isoNow(this.options.deps.clock);
    const data = cardRunPushedDataSchema.parse({
      cardId: record.cardId,
      runId: record.runId,
      projectId: record.projectId,
      at,
      branch: record.branch,
      headSha: step.headSha,
      ...(step.pr
        ? {
            prNumber: step.pr.number,
            prUrl: step.pr.url,
            prState: step.pr.state,
          }
        : {}),
    });
    this.options.emit({
      v: 1,
      ts: at,
      type: 'card_run.pushed',
      source: 'runner',
      project: { repo: record.repo, root: record.root },
      data,
    });
  }

  /** A card that exists here belongs to one project; any other is `not_found`. */
  private ownedOrAbsent(cardId: string, projectId: string): void {
    const record = this.store.load(cardId);
    if (record && record.projectId !== projectId) {
      throw new CommandFailure(
        'not_found',
        `card ${cardId} is not in ${projectId}`,
      );
    }
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

  private async kill(session: string): Promise<void> {
    try {
      if (await this.tmux.find(session)) await this.tmux.killSession(session);
    } catch {
      // Already gone.
    }
  }

  private setPhase(
    record: CardRecord,
    phase: CardRecord['phase'],
    extra: Pick<
      CardRunPhaseChangedData,
      'exitCode' | 'error' | 'wiring' | 'wiringReason'
    > = {},
  ): void {
    record.phase = phase;
    this.store.save(record);
    if (phase === 'stopped') return;
    const event: CardRunPhase = phase;
    const data = cardRunPhaseChangedDataSchema.parse({
      cardId: record.cardId,
      runId: record.runId,
      projectId: record.projectId,
      phase: event,
      at: isoNow(this.options.deps.clock),
      ...(phase === 'running' || phase === 'ended'
        ? { tmuxSession: record.tmuxSession }
        : {}),
      worktree: record.worktree,
      ...extra,
    });
    this.options.emit({
      v: 1,
      ts: isoNow(this.options.deps.clock),
      type: 'card_run.phase_changed',
      source: 'runner',
      project: { repo: record.repo, root: record.root },
      data,
    });
  }
}
