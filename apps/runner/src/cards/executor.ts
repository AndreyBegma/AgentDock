import { existsSync } from 'node:fs';
import {
  AGENTDOCK_WORKTREE_DIR,
  CARD_SESSION_POLL_MS,
} from '@agentdock/shared';
import {
  type CardCloseArgs,
  type CardCloseResult,
  type CardCollectArgs,
  type CardCollectResult,
  type CardRunArgs,
  type CardRunPhase,
  type CardRunPhaseChangedData,
  type CardRunResult,
  type CardStopArgs,
  type CardStopResult,
  cardRunPhaseChangedDataSchema,
  cardSessionName,
  type UnsequencedEvent,
} from '@agentdock/shared/protocol';
import { type Cancel, isoNow } from '../clock';
import { CommandFailure } from '../commands/failure';
import { projectCheckout, watchedProject } from '../control/target';
import { TmuxControl } from '../control/tmux';
import { resolveFleetProject } from '../fleet/project';
import { errorMessage, type Logger } from '../log';
import { profileOf, type SkillsDeps } from '../skills/deps';
import { RUN_FILES, writeJsonAtomic } from '../skills/run/record';
import { type AttachmentSource, syncAttachments } from './attachments';
import {
  collectBranch,
  collectCard,
  commitFiles,
  ensureWorktree,
  excludeFromGit,
  removeCardWorktree,
} from './git';
import { cardLaunchSpec, cardWorktreePath } from './launch';
import { type CardRecord, CardStore } from './record';
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
  /**
   * Where `card.run` downloads attachments from (#309 D9): the API and the
   * runner token. Required: without it every card with an attachment fails
   * with `attachments_unavailable`.
   */
  attachmentSource: AttachmentSource;
}

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
  private polling = false;
  private cancelPoll: Cancel = () => {};

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
        startedAt: isoNow(deps.clock),
        // #359 D3: the spec (and design) the PR links; only round 1 sends them.
        specFiles: args.files?.length
          ? args.files.map((f) => f.path)
          : previous?.specFiles,
      };
      this.setPhase(record, 'starting');
      let wiring: CardWiring;
      try {
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
        writeJsonAtomic(
          `${roundDir}/${RUN_FILES.launch}`,
          cardLaunchSpec(
            profile,
            args,
            record.worktree,
            this.options.otlpPort?.() ?? null,
            wiring.files,
          ),
        );
        const created = await this.tmux.newSession(
          tmuxSession,
          record.worktree,
          {},
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
      return { phase: 'running', tmuxSession };
    });
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
        );
      }
      if (record.branch !== args.branch) {
        throw new CommandFailure(
          'invalid_args',
          `card ${args.cardId} works on ${record.branch}, not ${args.branch}`,
        );
      }
      return collectCard(deps, record, args);
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

  /** D6 (2): reports every running session that is gone as `ended`. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const record of this.store.all()) {
        if (record.phase !== 'running' || this.chains.has(record.cardId))
          continue;
        if (await this.tmux.find(record.tmuxSession)) continue;
        // Re-read: an operation may have started while tmux answered.
        if (this.chains.has(record.cardId)) continue;
        const exit = this.store.exit(record);
        record.endedAt = isoNow(this.options.deps.clock);
        this.setPhase(
          record,
          'ended',
          exit?.code !== null && exit?.code !== undefined
            ? { exitCode: exit.code }
            : {},
        );
      }
    } finally {
      this.polling = false;
    }
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
