import { existsSync } from 'node:fs';
import type { PlanTurnPhase } from '@agentdock/shared';
import {
  type PlanCancelArgs,
  type PlanCancelResult,
  type PlanCloseArgs,
  type PlanCloseResult,
  type PlanTurnArgs,
  type PlanTurnResult,
  planTurnFinishedDataSchema,
  planTurnPhaseChangedDataSchema,
  type UnsequencedEvent,
} from '@agentdock/shared/protocol';
import { type AttachmentSource, syncAttachments } from '../cards/attachments';
import { type Cancel, isoNow } from '../clock';
import { CommandFailure } from '../commands/failure';
import { watchedProject } from '../control/target';
import { TmuxControl } from '../control/tmux';
import { resolveFleetProject } from '../fleet/project';
import { errorMessage, type Logger } from '../log';
import {
  gitOk,
  NETWORK_TIMEOUT_MS,
  profileOf,
  randomShortId,
  type SkillsDeps,
} from '../skills/deps';
import { writeJsonAtomic } from '../skills/run/record';
import {
  planTurnLaunchSpec,
  planTurnSessionName,
  planTurnTokenSaver,
  planWorktreePath,
} from './launch';
import {
  readTail,
  STREAM_TAIL_BYTES,
  type TurnEndReason,
  turnOutcome,
} from './result';
import type { RunSlots } from './slots';
import { type PlanRecord, PlanStore, type TurnRecord } from './store';

/** How often running turns are checked for an exit, a vanish or a timeout. */
export const PLAN_TICK_MS = 2000;
/** D15: how often idle plans are looked for. */
export const PLAN_CLEANUP_MS = 60 * 60_000;
/** D15: a plan with no turn for this long loses its worktree. */
export const PLAN_IDLE_MS = 14 * 24 * 60 * 60_000;

export interface PlanExecutorOptions {
  deps: SkillsDeps;
  /** `$XDG_STATE_HOME/agentdock/plans`, beside the skill runs. */
  plansDir: string;
  /** The argv that starts this runner: `exec-run <turnDir>` is appended. */
  selfCommand: readonly string[];
  /** The tmux server: empty for the user's own, `['-L', name]` in tests. */
  tmuxServer?: readonly string[];
  /** The cap's slots, shared with skill runs ("Concurrency"). */
  slots: RunSlots;
  emit: (event: UnsequencedEvent) => void;
  log: Logger;
  /** The OTLP receiver's bound port, null when it is off (#24 D9). */
  otlpPort?: () => number | null;
  /**
   * #337 D10: where `plan.turn` downloads attachments from — the API and the
   * runner token, as for `card.run`. Required, so a missing wiring is a
   * compile error, not a turn that fails at run time (#326).
   */
  attachmentSource: AttachmentSource;
  tickMs?: number;
  cleanupMs?: number;
  idleMs?: number;
}

const turnKey = (planId: string, turnId: string): string =>
  `${planId}/${turnId}`;
/** A plan turn's key in the shared slots. */
const slotId = (turn: TurnRecord): string =>
  `plan:${turnKey(turn.planId, turn.turnId)}`;

/**
 * Plan turns (docs/specs/172-planner.md D3, D15, D16). A turn is one headless
 * `claude -p` in the plan's worktree and its own tmux session, run by the
 * same `exec-run` as a skill run, with the prompt on stdin. The worktree is
 * the plan's for its life (`--resume` keys sessions by directory), detached
 * and fast-forwarded to `origin/<base>` before each turn. One turn per plan at
 * a time: each turn moves the worktree. Turns share the skill runs' cap.
 */
export class PlanTurnExecutor {
  readonly store: PlanStore;
  private readonly tmux: TmuxControl;
  /** Every turn that has not reached a terminal phase, by `planId/turnId`. */
  private readonly active = new Map<string, TurnRecord>();
  private readonly queue: string[] = [];
  private readonly busy = new Set<string>();
  /** Turns between leaving the queue and their tmux session existing. */
  private readonly preparing = new Set<string>();
  /** Plans being closed: a turn still preparing must not recreate the worktree. */
  private readonly closing = new Set<string>();
  /** `runId` → the turn it names, for turns the run log looked up on disk. */
  private readonly byRun = new Map<
    string,
    { planId: string; turnId: string }
  >();
  private ticking = false;
  private cancelTick: Cancel = () => {};
  private cancelCleanup: Cancel = () => {};
  private offFree: () => void = () => {};

  constructor(private readonly options: PlanExecutorOptions) {
    this.store = new PlanStore(options.plansDir);
    this.tmux = new TmuxControl(options.deps.exec, options.tmuxServer ?? []);
  }

  /** Picks up the turns a previous runner left, then starts the timers. */
  async start(): Promise<void> {
    for (const turn of this.store.turns()) {
      if (isTerminal(turn.phase)) continue;
      this.active.set(turnKey(turn.planId, turn.turnId), turn);
      if (turn.phase === 'queued') {
        this.queue.push(turnKey(turn.planId, turn.turnId));
        continue;
      }
      this.options.slots.tryAcquire(slotId(turn));
      if (!turn.startedAt) {
        await this.finish(turn, {
          phase: 'failed',
          resultTruncated: false,
          error: 'the runner restarted while the turn was being prepared',
        });
      }
      // A started turn is left to the tick: alive, exited or vanished.
    }
    this.offFree = this.options.slots.onFree(() => this.pump());
    this.pump();
    const { clock } = this.options.deps;
    this.cancelTick = clock.setInterval(
      () => void this.tick(),
      this.options.tickMs ?? PLAN_TICK_MS,
    );
    this.cancelCleanup = clock.setInterval(
      () => void this.cleanup(),
      this.options.cleanupMs ?? PLAN_CLEANUP_MS,
    );
  }

  /** Stops watching. Sessions keep running; the next start resumes them. */
  stop(): void {
    this.cancelTick();
    this.cancelCleanup();
    this.offFree();
  }

  /** A turn by id, live or from its directory. */
  turn(planId: string, turnId: string): TurnRecord | null {
    return (
      this.active.get(turnKey(planId, turnId)) ??
      this.store.loadTurn(planId, turnId)
    );
  }

  /**
   * A turn by its `runs` row, for the run log (#183): a live turn, else one
   * on disk. The index keeps a finished turn's last polls off a full scan.
   */
  record(runId: string): TurnRecord | null {
    for (const turn of this.active.values()) {
      if (turn.runId === runId) return turn;
    }
    const known = this.byRun.get(runId);
    if (known) {
      const turn = this.store.loadTurn(known.planId, known.turnId);
      if (turn) return turn;
      this.byRun.delete(runId);
    }
    let found: TurnRecord | null = null;
    for (const turn of this.store.turns()) {
      this.byRun.set(turn.runId, { planId: turn.planId, turnId: turn.turnId });
      if (turn.runId === runId) found = turn;
    }
    return found;
  }

  /** The turn's `stream.jsonl`; an unknown run opens nothing. */
  streamFile(runId: string): string {
    const turn = this.record(runId);
    return turn ? this.store.file(turn, 'stream') : '';
  }

  /** `plan.turn` (D3, D15, D16). Answers once the turn is queued or running. */
  async run(args: PlanTurnArgs): Promise<PlanTurnResult> {
    const { deps } = this.options;
    const profile = profileOf(deps, args.profileKey);
    if (profile.runtime !== 'claude') {
      throw new CommandFailure(
        'unsupported_runtime',
        `plan turns need a claude profile; ${profile.id} is ${profile.runtime}`,
      );
    }
    const project = watchedProject(args, deps.watchedProjects());
    let plan = this.store.loadPlan(args.planId);
    if (plan && (plan.projectId !== project.id || plan.root !== project.root)) {
      throw new CommandFailure(
        'not_found',
        `no plan ${args.planId} in ${args.projectId}`,
      );
    }
    if (
      this.active.has(turnKey(args.planId, args.turnId)) ||
      this.store.turnExists(args.planId, args.turnId)
    ) {
      throw new CommandFailure(
        'already_exists',
        `turn ${args.turnId} already exists`,
      );
    }
    const running = [...this.active.values()].find(
      (t) => t.planId === args.planId,
    );
    if (running) {
      throw new CommandFailure(
        'busy',
        `plan ${args.planId} already has turn ${running.turnId} in progress`,
      );
    }
    const now = isoNow(deps.clock);
    const shortId = deps.shortId ?? randomShortId;
    if (!plan) {
      const fleet = await resolveFleetProject(deps.exec, project);
      const planShortId = shortId();
      plan = {
        planId: args.planId,
        projectId: project.id,
        root: project.root,
        repo: fleet.repo,
        shortId: planShortId,
        worktree: planWorktreePath(project.root, planShortId),
        lastActiveAt: now,
      };
    }
    plan.lastActiveAt = now;
    this.store.savePlan(plan);
    this.closing.delete(args.planId);

    const { prompt, ...rest } = args;
    const turnShortId = shortId();
    const turn: TurnRecord = {
      ...rest,
      shortId: turnShortId,
      tmuxSession: planTurnSessionName(turnShortId),
      phase: 'queued',
      queuedAt: now,
    };
    if (!this.store.createTurn(turn, prompt)) {
      throw new CommandFailure(
        'already_exists',
        `turn ${args.turnId} already exists`,
      );
    }
    const key = turnKey(turn.planId, turn.turnId);
    this.active.set(key, turn);
    this.queue.push(key);
    this.setPhase(turn, 'queued');
    this.pump();
    return { phase: turn.phase === 'queued' ? 'queued' : 'running' };
  }

  /** `plan.cancel`: a queued turn leaves the queue, a running one loses its session. */
  async cancel(args: PlanCancelArgs): Promise<PlanCancelResult> {
    const record = this.turn(args.planId, args.turnId);
    if (!record) {
      throw new CommandFailure(
        'not_found',
        `no turn ${args.turnId} in plan ${args.planId}`,
      );
    }
    const key = turnKey(args.planId, args.turnId);
    const live = this.active.get(key);
    if (!live || this.busy.has(key)) return { cancelled: false };
    if (live.phase === 'queued') {
      const at = this.queue.indexOf(key);
      if (at >= 0) this.queue.splice(at, 1);
      await this.finish(live, { phase: 'cancelled', resultTruncated: false });
      return { cancelled: true };
    }
    live.cancelRequested = true;
    this.store.saveTurn(live);
    // Still preparing: `prepare` sees the flag before or after it starts the session.
    if (this.preparing.has(key)) return { cancelled: true };
    await this.kill(live);
    await this.end(live, 'cancelled');
    return { cancelled: true };
  }

  /** `plan.close` (D15): its turns cancelled, its worktree and state removed. */
  async close(args: PlanCloseArgs): Promise<PlanCloseResult> {
    const plan = this.store.loadPlan(args.planId);
    if (!plan) return { removed: false };
    if (plan.projectId !== args.projectId) {
      throw new CommandFailure(
        'not_found',
        `no plan ${args.planId} in ${args.projectId}`,
      );
    }
    return { removed: await this.closePlan(plan) };
  }

  /** Checks every running turn once: exited, vanished, or over its timeout. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.options.deps.clock.now();
      for (const turn of [...this.active.values()]) {
        const key = turnKey(turn.planId, turn.turnId);
        if (
          turn.phase !== 'running' ||
          !turn.startedAt ||
          this.busy.has(key) ||
          this.preparing.has(key)
        )
          continue;
        if (this.store.exit(turn)) {
          await this.end(turn, 'exited');
          continue;
        }
        if (!(await this.tmux.find(turn.tmuxSession))) {
          await this.end(turn, this.store.exit(turn) ? 'exited' : 'vanished');
          continue;
        }
        if (now - Date.parse(turn.startedAt) >= turn.timeoutSec * 1000) {
          await this.kill(turn);
          await this.end(turn, 'timed_out');
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** D15: the worktrees of plans idle for 14 days are removed. */
  async cleanup(): Promise<void> {
    const now = this.options.deps.clock.now();
    const idleMs = this.options.idleMs ?? PLAN_IDLE_MS;
    for (const plan of this.store.plans()) {
      if ([...this.active.values()].some((t) => t.planId === plan.planId))
        continue;
      if (now - Date.parse(plan.lastActiveAt) < idleMs) continue;
      try {
        await this.closePlan(plan);
        this.options.log.info('planner: removed an idle plan worktree', {
          planId: plan.planId,
        });
      } catch (error) {
        this.options.log.warn('planner: cannot remove an idle plan', {
          planId: plan.planId,
          error: errorMessage(error),
        });
      }
    }
  }

  private async closePlan(plan: PlanRecord): Promise<boolean> {
    this.closing.add(plan.planId);
    for (const turn of [...this.active.values()]) {
      if (turn.planId === plan.planId) {
        await this.cancel({ planId: turn.planId, turnId: turn.turnId });
      }
    }
    // A turn still preparing removes the worktree itself once it sees `closing`.
    const preparing = [...this.active.values()].some(
      (t) => t.planId === plan.planId,
    );
    const removed = await this.removeWorktree(plan);
    if (!preparing) this.store.removePlan(plan.planId);
    return removed;
  }

  /** Starts queued turns, oldest first, while the shared cap has a slot. */
  private pump(): void {
    while (this.queue.length > 0) {
      const key = this.queue[0] as string;
      const turn = this.active.get(key);
      if (!turn || turn.phase !== 'queued') {
        this.queue.shift();
        continue;
      }
      if (!this.options.slots.tryAcquire(slotId(turn))) return;
      this.queue.shift();
      this.setPhase(turn, 'running');
      void this.prepare(turn);
    }
  }

  /** D15: the plan's worktree at `origin/<base>`, `run.json`, then the tmux session. */
  private async prepare(turn: TurnRecord): Promise<void> {
    const { deps } = this.options;
    const { exec } = deps;
    const key = turnKey(turn.planId, turn.turnId);
    this.preparing.add(key);
    try {
      const plan = this.store.loadPlan(turn.planId);
      if (!plan) throw new Error(`plan ${turn.planId} has no state`);
      // Best effort: an unreachable origin still runs on the base it last fetched.
      await exec(
        'git',
        ['-C', plan.root, 'fetch', '--quiet', 'origin', turn.base],
        { timeoutMs: NETWORK_TIMEOUT_MS },
      );
      const base = await exec('git', [
        '-C',
        plan.root,
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/remotes/origin/${turn.base}^{commit}`,
      ]);
      if (!base || base.code !== 0)
        throw new Error(`origin/${turn.base} does not exist`);
      const commit = base.stdout.trim();
      if (existsSync(plan.worktree)) {
        // The fast-forward of D15. Plan mode writes nothing, so nothing is lost.
        await gitOk(exec, [
          '-C',
          plan.worktree,
          'checkout',
          '--quiet',
          '--force',
          '--detach',
          commit,
        ]);
      } else {
        await gitOk(exec, [
          '-C',
          plan.root,
          'worktree',
          'add',
          '--quiet',
          '--detach',
          plan.worktree,
          commit,
        ]);
      }
      if (turn.cancelRequested || this.closing.has(turn.planId)) {
        if (this.closing.has(turn.planId)) {
          await this.removeWorktree(plan);
        }
        await this.finish(turn, { phase: 'cancelled', resultTruncated: false });
        if (this.closing.has(turn.planId)) this.store.removePlan(turn.planId);
        return;
      }
      // #337 D10: the files the person attached, in the worktree before the
      // session starts; one that cannot be had fails the turn.
      await syncAttachments(
        deps,
        plan.worktree,
        turn.attachments ?? [],
        this.options.attachmentSource,
      );
      const profile = profileOf(deps, turn.profileKey);
      writeJsonAtomic(
        this.store.file(turn, 'launch'),
        planTurnLaunchSpec(
          profile,
          turn,
          plan.worktree,
          this.store.promptFile(turn),
          this.options.otlpPort?.() ?? null,
          planTurnTokenSaver(
            profile,
            turn,
            deps.home,
            this.store.turnDir(turn.planId, turn.turnId),
            this.options.selfCommand,
          ),
        ),
      );
      turn.startedAt = isoNow(deps.clock);
      this.store.saveTurn(turn);
      const created = await this.tmux.newSession(
        turn.tmuxSession,
        plan.worktree,
        {},
        [
          ...this.options.selfCommand,
          'exec-run',
          this.store.turnDir(turn.planId, turn.turnId),
        ],
      );
      if (!created.ok)
        throw new Error(`tmux new-session failed: ${created.stderr}`);
      this.preparing.delete(key);
      if (turn.cancelRequested) {
        // Cancelled while the session was being created.
        await this.kill(turn);
        await this.end(turn, 'cancelled');
      }
    } catch (error) {
      this.options.log.warn('planner: a turn failed to start', {
        planId: turn.planId,
        turnId: turn.turnId,
        error: errorMessage(error),
      });
      await this.finish(turn, {
        phase: 'failed',
        resultTruncated: false,
        error: errorMessage(error).slice(0, 2000),
      });
    } finally {
      this.preparing.delete(key);
    }
  }

  /** The session is over: read what it left, then finish. */
  private async end(turn: TurnRecord, reason: TurnEndReason): Promise<void> {
    const key = turnKey(turn.planId, turn.turnId);
    // Finished already (a cancel raced the session's start): report it once.
    if (this.busy.has(key) || !this.active.has(key)) return;
    this.busy.add(key);
    try {
      await this.finish(
        turn,
        turnOutcome({
          reason,
          exit: this.store.exit(turn),
          stream: readTail(this.store.file(turn, 'stream'), STREAM_TAIL_BYTES),
          stderr: readTail(this.store.file(turn, 'stderr'), 64 * 1024),
          timeoutSec: turn.timeoutSec,
          fallbackSessionId: turn.startedAt ? turn.session.id : undefined,
        }),
      );
    } finally {
      this.busy.delete(key);
    }
  }

  private async finish(
    turn: TurnRecord,
    outcome: ReturnType<typeof turnOutcome>,
  ): Promise<void> {
    const at = isoNow(this.options.deps.clock);
    turn.finishedAt = at;
    this.active.delete(turnKey(turn.planId, turn.turnId));
    const plan = this.store.loadPlan(turn.planId);
    if (plan) {
      plan.lastActiveAt = at;
      this.store.savePlan(plan);
    }
    this.setPhase(turn, outcome.phase);
    let data: unknown;
    try {
      data = planTurnFinishedDataSchema.parse({
        ...this.ref(turn),
        ...outcome,
        at,
      });
    } catch (error) {
      data = planTurnFinishedDataSchema.parse({
        ...this.ref(turn),
        phase: 'failed',
        at,
        resultTruncated: false,
        error: `cannot report the turn: ${errorMessage(error)}`.slice(0, 2000),
      });
    }
    this.emitEvent(turn, 'plan_turn.finished', data);
    // Released after the event, so the API hears the end before the next start.
    this.options.slots.release(slotId(turn));
  }

  private ref(turn: TurnRecord) {
    return {
      planId: turn.planId,
      turnId: turn.turnId,
      runId: turn.runId,
      projectId: turn.projectId,
    };
  }

  private setPhase(turn: TurnRecord, phase: PlanTurnPhase): void {
    turn.phase = phase;
    if (this.store.turnExists(turn.planId, turn.turnId))
      this.store.saveTurn(turn);
    const data = planTurnPhaseChangedDataSchema.parse({
      ...this.ref(turn),
      phase,
      at: isoNow(this.options.deps.clock),
    });
    this.emitEvent(turn, 'plan_turn.phase_changed', data);
  }

  private emitEvent(turn: TurnRecord, type: string, data: unknown): void {
    this.options.emit({
      v: 1,
      ts: isoNow(this.options.deps.clock),
      type,
      source: 'runner',
      project: { repo: this.repoOf(turn), root: turn.root },
      data,
    });
  }

  private repoOf(turn: TurnRecord): string {
    return this.store.loadPlan(turn.planId)?.repo ?? turn.root;
  }

  private async kill(turn: TurnRecord): Promise<void> {
    try {
      await this.tmux.killSession(turn.tmuxSession);
    } catch {
      // Already gone: the end is collected all the same.
    }
  }

  /** The plan's worktree is gone; true when there was one to remove. */
  private async removeWorktree(plan: PlanRecord): Promise<boolean> {
    if (!existsSync(plan.worktree)) return false;
    await gitOk(this.options.deps.exec, [
      '-C',
      plan.root,
      'worktree',
      'remove',
      '--force',
      plan.worktree,
    ]);
    return true;
  }
}

const isTerminal = (phase: PlanTurnPhase): boolean =>
  phase === 'succeeded' || phase === 'failed' || phase === 'cancelled';
