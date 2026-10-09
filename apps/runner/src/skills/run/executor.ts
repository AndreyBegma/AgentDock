import { existsSync } from 'node:fs';
import {
  isRunnableSkill,
  isTerminalSkillRunPhase,
  type SkillCancelArgs,
  type SkillCancelResult,
  type SkillRunArgs,
  type SkillRunPhase,
  type SkillRunResult,
  skillRunBranch,
  skillRunFinishedDataSchema,
  skillRunPhaseChangedDataSchema,
  skillRunSessionName,
  type UnsequencedEvent,
} from '@agentdock/shared/protocol';
import { type Cancel, isoNow } from '../../clock';
import { CommandFailure } from '../../commands/failure';
import { watchedProject } from '../../control/target';
import { TmuxControl } from '../../control/tmux';
import { resolveFleetProject } from '../../fleet/project';
import { errorMessage, type Logger } from '../../log';
import {
  GH_TIMEOUT_MS,
  gitOk,
  NETWORK_TIMEOUT_MS,
  profileOf,
  randomShortId,
  type SkillsDeps,
} from '../deps';
import { findRunnableSkill } from '../inventory';
import { type Collected, collectRun, type EndReason } from './collect';
import { finishedData } from './finished';
import { launchSpec, runWorktreePath } from './launch';
import { type RunRecord, RunStore, writeJsonAtomic } from './record';

/** How often running sessions are checked for an exit, a vanish or a timeout. */
export const RUN_TICK_MS = 2000;
/** D10: how often open run PRs are checked for merged or closed. */
export const RUN_CLEANUP_MS = 10 * 60_000;

export interface ExecutorOptions {
  deps: SkillsDeps;
  /** `$XDG_STATE_HOME/agentdock/runs` (D7). */
  runsDir: string;
  /** The argv that starts this runner: `exec-run <runDir>` is appended (D7). */
  selfCommand: readonly string[];
  /** The tmux server: empty for the user's own, `['-L', name]` in tests. */
  tmuxServer?: readonly string[];
  maxConcurrentRuns: number;
  maxTimeoutSec: number;
  emit: (event: UnsequencedEvent) => void;
  log: Logger;
  /** The OTLP receiver's bound port, null when it is off (D9). */
  otlpPort?: () => number | null;
  tickMs?: number;
  cleanupMs?: number;
}

type Listener = (record: RunRecord) => void;

const ACTIVE: readonly SkillRunPhase[] = ['preparing', 'running', 'collecting'];

/**
 * The skill run executor (D7, D10–D12). Each run is a headless session in its
 * own worktree and tmux session; the executor queues runs over the
 * concurrency cap, watches sessions for their end and their timeout, collects
 * the result and reports every phase as an event. State lives in each run
 * directory, so a runner restart picks every run back up — the sessions
 * themselves run on in tmux.
 */
export class SkillRunExecutor {
  readonly store: RunStore;
  private readonly tmux: TmuxControl;
  /** Every run that has not reached a terminal phase. */
  private readonly active = new Map<string, RunRecord>();
  private readonly queue: string[] = [];
  /** Finished `pr` runs whose worktree waits for the PR to close. */
  private readonly awaitingPr = new Map<string, RunRecord>();
  private readonly busy = new Set<string>();
  private readonly listeners = new Set<Listener>();
  private ticking = false;
  private cancelTick: Cancel = () => {};
  private cancelCleanup: Cancel = () => {};

  constructor(private readonly options: ExecutorOptions) {
    this.store = new RunStore(options.runsDir);
    this.tmux = new TmuxControl(options.deps.exec, options.tmuxServer ?? []);
  }

  /** Picks up the runs a previous runner left, then starts the timers. */
  async start(): Promise<void> {
    for (const record of this.store.all()) {
      if (isTerminalSkillRunPhase(record.phase)) {
        if (record.pr && !record.cleanedUp)
          this.awaitingPr.set(record.runId, record);
        continue;
      }
      this.active.set(record.runId, record);
      if (record.phase === 'queued') this.queue.push(record.runId);
      else if (record.phase === 'preparing') {
        if (record.startedAt && (await this.tmux.find(record.session))) {
          this.setPhase(record, 'running');
        } else {
          await this.removeWorktree(record);
          await this.finish(record, {
            ...this.nothingCollected('failed'),
            error: 'the runner restarted while the run was being prepared',
          });
        }
      } else if (record.phase === 'collecting') {
        void this.end(record, record.endReason ?? 'vanished');
      }
    }
    this.pump();
    const { clock } = this.options.deps;
    this.cancelTick = clock.setInterval(
      () => void this.tick(),
      this.options.tickMs ?? RUN_TICK_MS,
    );
    this.cancelCleanup = clock.setInterval(
      () => void this.cleanup(),
      this.options.cleanupMs ?? RUN_CLEANUP_MS,
    );
  }

  /** Stops watching. The sessions keep running; the next start resumes them. */
  stop(): void {
    this.cancelTick();
    this.cancelCleanup();
  }

  /** Called on every phase change of every run. */
  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A run by id, live or from its directory. */
  record(runId: string): RunRecord | null {
    return (
      this.active.get(runId) ??
      this.awaitingPr.get(runId) ??
      this.store.load(runId)
    );
  }

  streamFile(runId: string): string {
    return this.store.file(runId, 'stream');
  }

  /** The live tmux session of a running run of this project, for a terminal attach. */
  runSession(projectId: string, root: string, runId: string): string | null {
    const record = this.active.get(runId);
    return record &&
      record.projectId === projectId &&
      record.root === root &&
      record.phase === 'running'
      ? record.session
      : null;
  }

  /** `skill.run` (D7, D8, D11). Answers once the run is queued or preparing. */
  async run(args: SkillRunArgs): Promise<SkillRunResult> {
    const { deps } = this.options;
    if (!isRunnableSkill(args.skill)) {
      throw new CommandFailure(
        'not_runnable',
        `${args.skill} cannot run as a skill`,
      );
    }
    const profile = profileOf(deps, args.profileKey);
    if (profile.runtime !== 'claude') {
      throw new CommandFailure(
        'unsupported_runtime',
        `skill runs need a claude profile; ${profile.id} is ${profile.runtime}`,
      );
    }
    const project = watchedProject(args, deps.watchedProjects());
    if (this.active.has(args.runId) || this.store.exists(args.runId)) {
      throw new CommandFailure(
        'already_exists',
        `run ${args.runId} already exists`,
      );
    }
    if (!(await findRunnableSkill(args.skill, project, profile, deps))) {
      throw new CommandFailure(
        'not_found',
        `${args.skill} is not installed for ${project.id} on ${profile.id}`,
      );
    }
    const fleet = await resolveFleetProject(deps.exec, project);
    const shortId = (deps.shortId ?? randomShortId)();
    const record: RunRecord = {
      ...args,
      timeoutSec: Math.min(args.timeoutSec, this.options.maxTimeoutSec),
      shortId,
      repo: fleet.repo,
      session: skillRunSessionName(shortId),
      worktree: runWorktreePath(project.root, shortId),
      branch: skillRunBranch(shortId, args.skill),
      phase: 'queued',
      queuedAt: isoNow(deps.clock),
    };
    if (!this.store.create(record)) {
      throw new CommandFailure(
        'already_exists',
        `run ${args.runId} already exists`,
      );
    }
    this.active.set(record.runId, record);
    this.queue.push(record.runId);
    this.setPhase(record, 'queued');
    this.pump();
    return { phase: record.phase === 'queued' ? 'queued' : 'preparing' };
  }

  /** `skill.cancel` (D11). A run of another project is `not_found`. */
  async cancel(args: SkillCancelArgs): Promise<SkillCancelResult> {
    const record = this.record(args.runId);
    if (!record || record.projectId !== args.projectId) {
      throw new CommandFailure(
        'not_found',
        `no run ${args.runId} in ${args.projectId}`,
      );
    }
    const live = this.active.get(record.runId);
    if (!live || isTerminalSkillRunPhase(live.phase))
      return { cancelled: false };
    switch (live.phase) {
      case 'queued': {
        const at = this.queue.indexOf(live.runId);
        if (at >= 0) this.queue.splice(at, 1);
        await this.finish(live, this.nothingCollected('cancelled'));
        return { cancelled: true };
      }
      case 'preparing':
        live.cancelRequested = true;
        this.store.save(live);
        return { cancelled: true };
      case 'running':
        if (this.busy.has(live.runId)) return { cancelled: false };
        live.cancelRequested = true;
        this.store.save(live);
        await this.kill(live);
        void this.end(live, 'cancelled');
        return { cancelled: true };
      default:
        return { cancelled: false };
    }
  }

  /** Checks every running session once: exited, vanished, or over its timeout. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.options.deps.clock.now();
      for (const record of [...this.active.values()]) {
        if (record.phase !== 'running' || this.busy.has(record.runId)) continue;
        if (this.store.exit(record.runId)) {
          void this.end(record, 'exited');
          continue;
        }
        if (!(await this.tmux.find(record.session))) {
          void this.end(
            record,
            this.store.exit(record.runId) ? 'exited' : 'vanished',
          );
          continue;
        }
        const started = record.startedAt ? Date.parse(record.startedAt) : now;
        if (now - started >= record.timeoutSec * 1000) {
          await this.kill(record);
          void this.end(record, 'timed_out');
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** D10: removes the worktree of every run whose PR was merged or closed. */
  async cleanup(): Promise<void> {
    const { exec } = this.options.deps;
    for (const record of [...this.awaitingPr.values()]) {
      const { pr } = record;
      if (!pr) continue;
      const view = await exec(
        'gh',
        [
          'pr',
          'view',
          String(pr.number),
          '--repo',
          pr.github,
          '--json',
          'state',
          '--jq',
          '.state',
        ],
        { timeoutMs: GH_TIMEOUT_MS },
      );
      if (!view || view.code !== 0) continue;
      const state = view.stdout.trim();
      if (state !== 'MERGED' && state !== 'CLOSED') continue;
      await this.removeWorktree(record);
      this.store.save(record);
      this.awaitingPr.delete(record.runId);
      this.options.log.info('skills: removed the worktree of a closed run PR', {
        runId: record.runId,
        pr: pr.number,
      });
    }
  }

  /** Starts queued runs, oldest first, while the cap allows (D11). */
  private pump(): void {
    const running = () =>
      [...this.active.values()].filter((r) => ACTIVE.includes(r.phase)).length;
    while (
      this.queue.length > 0 &&
      running() < this.options.maxConcurrentRuns
    ) {
      const runId = this.queue.shift() as string;
      const record = this.active.get(runId);
      if (!record || record.phase !== 'queued') continue;
      this.setPhase(record, 'preparing');
      void this.prepare(record);
    }
  }

  /** D7: worktree from `origin/<base>`, `run.json`, then the tmux session. */
  private async prepare(record: RunRecord): Promise<void> {
    const { deps } = this.options;
    const { exec } = deps;
    try {
      // Best effort: an unreachable origin still runs on the base it last fetched.
      await exec(
        'git',
        ['-C', record.root, 'fetch', '--quiet', 'origin', record.base],
        {
          timeoutMs: NETWORK_TIMEOUT_MS,
        },
      );
      const base = await exec('git', [
        '-C',
        record.root,
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/remotes/origin/${record.base}^{commit}`,
      ]);
      if (!base || base.code !== 0)
        throw new Error(`origin/${record.base} does not exist`);
      record.baseCommit = base.stdout.trim();
      this.store.save(record);
      await gitOk(exec, [
        '-C',
        record.root,
        'worktree',
        'add',
        '--quiet',
        '--no-track',
        '-b',
        record.branch,
        record.worktree,
        record.baseCommit,
      ]);
      if (record.cancelRequested) {
        await this.removeWorktree(record);
        await this.finish(record, this.nothingCollected('cancelled'));
        return;
      }
      const profile = profileOf(deps, record.profileKey);
      writeJsonAtomic(
        this.store.file(record.runId, 'launch'),
        launchSpec(
          profile,
          record,
          record.worktree,
          this.options.otlpPort?.() ?? null,
        ),
      );
      record.startedAt = isoNow(deps.clock);
      this.store.save(record);
      const created = await this.tmux.newSession(
        record.session,
        record.worktree,
        {},
        [...this.options.selfCommand, 'exec-run', this.store.dir(record.runId)],
      );
      if (!created.ok)
        throw new Error(`tmux new-session failed: ${created.stderr}`);
      this.setPhase(record, 'running');
      if (record.cancelRequested) {
        await this.kill(record);
        void this.end(record, 'cancelled');
      }
    } catch (error) {
      this.options.log.warn('skills: a run failed to start', {
        runId: record.runId,
        error: errorMessage(error),
      });
      await this.removeWorktree(record);
      await this.finish(record, {
        ...this.nothingCollected('failed'),
        error: errorMessage(error),
      });
    }
  }

  /** The session is over: collect (D10), clean up, finish. */
  private async end(record: RunRecord, reason: EndReason): Promise<void> {
    if (this.busy.has(record.runId)) return;
    this.busy.add(record.runId);
    try {
      record.endReason = reason;
      this.setPhase(record, 'collecting');
      let collected: Collected;
      try {
        collected = await collectRun(
          this.options.deps,
          this.store,
          record,
          reason,
        );
        if (collected.pr && collected.prGithub) {
          record.pr = { ...collected.pr, github: collected.prGithub };
        }
      } catch (error) {
        collected = {
          ...this.nothingCollected(
            reason === 'cancelled'
              ? 'cancelled'
              : reason === 'timed_out'
                ? 'timed_out'
                : 'failed',
          ),
          exitCode: this.store.exit(record.runId)?.code ?? null,
          error: `cannot collect the run: ${errorMessage(error)}`,
        };
      }
      if (!collected.keepWorktree) await this.removeWorktree(record);
      await this.finish(record, collected);
    } finally {
      this.busy.delete(record.runId);
    }
  }

  private nothingCollected(phase: Collected['phase']): Collected {
    return {
      phase,
      exitCode: null,
      reportText: null,
      changedFiles: [],
      changedFilesTotal: 0,
      patch: null,
      keepWorktree: false,
    };
  }

  private async finish(record: RunRecord, collected: Collected): Promise<void> {
    const finishedAt = isoNow(this.options.deps.clock);
    record.finishedAt = finishedAt;
    this.active.delete(record.runId);
    if (record.pr && !record.cleanedUp)
      this.awaitingPr.set(record.runId, record);
    this.setPhase(record, collected.phase);
    let data: unknown;
    try {
      data = finishedData({
        runId: record.runId,
        projectId: record.projectId,
        phase: collected.phase,
        finishedAt,
        exitCode: collected.exitCode,
        reportText: collected.reportText,
        changedFiles: collected.changedFiles,
        changedFilesTotal: collected.changedFilesTotal,
        patch: collected.patch,
        ...(collected.pr ? { pr: collected.pr } : {}),
        ...(collected.error ? { error: collected.error } : {}),
      });
    } catch (error) {
      data = skillRunFinishedDataSchema.parse({
        ...finishedData({
          runId: record.runId,
          projectId: record.projectId,
          phase: collected.phase,
          finishedAt,
          exitCode: collected.exitCode,
        }),
        error: `cannot report the run: ${errorMessage(error)}`.slice(0, 500),
      });
    }
    this.emitEvent(record, 'skill_run.finished', data);
    this.pump();
  }

  private setPhase(record: RunRecord, phase: SkillRunPhase): void {
    record.phase = phase;
    this.store.save(record);
    const data = skillRunPhaseChangedDataSchema.parse({
      runId: record.runId,
      projectId: record.projectId,
      phase,
      at: isoNow(this.options.deps.clock),
      ...(record.startedAt && phase !== 'preparing'
        ? { tmuxSession: record.session }
        : {}),
      ...(record.baseCommit
        ? { worktree: record.worktree, branch: record.branch }
        : {}),
    });
    this.emitEvent(record, 'skill_run.phase_changed', data);
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch (error) {
        this.options.log.warn('skills: a run listener failed', {
          error: errorMessage(error),
        });
      }
    }
  }

  private emitEvent(record: RunRecord, type: string, data: unknown): void {
    this.options.emit({
      v: 1,
      ts: isoNow(this.options.deps.clock),
      type,
      source: 'runner',
      project: { repo: record.repo, root: record.root },
      data,
    });
  }

  private async kill(record: RunRecord): Promise<void> {
    try {
      await this.tmux.killSession(record.session);
    } catch {
      // Already gone: the end is collected all the same.
    }
  }

  /** The run's worktree and local branch, removed; a pushed branch stays for its PR. */
  private async removeWorktree(record: RunRecord): Promise<void> {
    const { exec } = this.options.deps;
    if (existsSync(record.worktree)) {
      await exec('git', [
        '-C',
        record.root,
        'worktree',
        'remove',
        '--force',
        record.worktree,
      ]);
    }
    await exec('git', [
      '-C',
      record.root,
      'branch',
      '--quiet',
      '-D',
      record.branch,
    ]);
    record.cleanedUp = true;
  }
}
