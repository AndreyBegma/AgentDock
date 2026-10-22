import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { PlanTurnPhase } from '@nautelle/shared';
import { planTurnPhaseSchema } from '@nautelle/shared';
import {
  skillRunIdSchema,
  skillRunShortIdSchema,
  type UiProfileBuildArgs,
  type UiProfileBuildResult,
  type UiProfileCancelArgs,
  type UiProfileCancelResult,
  type UnsequencedEvent,
  uiProfileBuildArgsSchema,
  uiProfileBuildFinishedDataSchema,
  uiProfileBuildPhaseChangedDataSchema,
} from '@nautelle/shared/protocol';
import { z } from 'zod';
import type { CaptureSpawn } from '../capture/executor';
import { type Cancel, isoNow } from '../clock';
import { CommandFailure } from '../commands/failure';
import type { ConfigProfile } from '../config';
import { watchedProject } from '../control/target';
import { TmuxControl } from '../control/tmux';
import type { Env } from '../env';
import { resolveFleetProject } from '../fleet/project';
import { type RunNotes, runWorkKey } from '../handoff/runs';
import { type TokenSaverLaunch, tokenSaverLaunch } from '../launch/token-saver';
import { errorMessage, type Logger } from '../log';
import type { OtlpEndpoint } from '../otlp/token';
import {
  readTail,
  STREAM_TAIL_BYTES,
  type TurnEndReason,
  turnOutcome,
} from '../planner/result';
import type { RunSlots } from '../planner/slots';
import {
  gitOk,
  NETWORK_TIMEOUT_MS,
  profileOf,
  randomShortId,
  type SkillsDeps,
} from '../skills/deps';
import { runEnv } from '../skills/run/launch';
import {
  type ExitRecord,
  exitRecordSchema,
  type LaunchSpec,
  RUN_FILES,
  readJson,
  writeJsonAtomic,
} from '../skills/run/record';
import { UiProfileLearner } from './learn';

/** How often running builds are checked for an exit, a vanish or a timeout. */
export const UIPROFILE_TICK_MS = 2000;

const PROMPT_FILE = 'prompt.md';

/** `<parent>/.wt-<repo>-uiprofile-<shortid>`, beside the main checkout. */
export const uiProfileWorktreePath = (
  root: string,
  shortId: string,
): string => {
  const trimmed = root.replace(/\/+$/, '');
  return join(
    dirname(trimmed),
    `.wt-${basename(trimmed)}-uiprofile-${shortId}`,
  );
};

export const uiProfileSessionName = (shortId: string): string =>
  `nautelle-uiprofile-${shortId}`;

/**
 * What `exec-run` starts for a build: headless, read-only (`plan`), the
 * prompt on stdin. #445: the Token saver's flags before the first flag.
 */
export const uiProfileLaunchSpec = (
  profile: ConfigProfile,
  build: Pick<UiProfileBuildArgs, 'model' | 'projectId' | 'runId'>,
  worktree: string,
  promptFile: string,
  otlp: OtlpEndpoint | null,
  tokenSaver?: TokenSaverLaunch | null,
): LaunchSpec => ({
  binary: profile.binary ?? profile.runtime,
  args: [
    ...profile.args,
    ...(tokenSaver?.args ?? []),
    '-p',
    '--model',
    build.model,
    '--permission-mode',
    'plan',
    '--output-format',
    'stream-json',
    '--verbose',
  ],
  env: { ...runEnv(profile, build, otlp), ...(tokenSaver?.env ?? {}) },
  cwd: worktree,
  stdin: promptFile,
});

/**
 * #445: a build's Token saver — the scout, no `agentdock` (a design build
 * does not use it); `null` when off.
 */
export const uiProfileTokenSaver = (
  profile: ConfigProfile,
  build: Pick<UiProfileBuildArgs, 'tokenSaver' | 'runId' | 'projectId'>,
  home: string,
  runDir: string,
  selfCommand: readonly string[],
): TokenSaverLaunch | null =>
  tokenSaverLaunch({
    config: build.tokenSaver,
    profile,
    home,
    dir: runDir,
    selfCommand,
    runKind: 'ui_profile',
    projectId: build.projectId,
    runId: build.runId,
    runnerMcp: false,
    scout: true,
  });

/** A build as the executor keeps it. The prompt is in `prompt.md`, never here. */
const buildRecordSchema = uiProfileBuildArgsSchema
  .omit({ prompt: true })
  .extend({
    shortId: skillRunShortIdSchema,
    repo: z.string().min(1),
    worktree: z.string().min(1),
    tmuxSession: z.string().min(1),
    phase: planTurnPhaseSchema,
    queuedAt: z.iso.datetime(),
    startedAt: z.iso.datetime().optional(),
    finishedAt: z.iso.datetime().optional(),
    cancelRequested: z.boolean().optional(),
    /** #449: the work's key, when the build runs with Context handoff. */
    handoffKey: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  });
type BuildRecord = z.infer<typeof buildRecordSchema>;

export interface UiProfileExecutorOptions {
  deps: SkillsDeps;
  /** `$XDG_STATE_HOME/nautelle/uiprofile`, beside the plans. */
  buildsDir: string;
  /** The argv that starts this runner: `exec-run <buildDir>` is appended. */
  selfCommand: readonly string[];
  /** The tmux server: empty for the user's own, `['-L', name]` in tests. */
  tmuxServer?: readonly string[];
  /** The cap's slots, shared with skill runs and plan turns. */
  slots: RunSlots;
  emit: (event: UnsequencedEvent) => void;
  log: Logger;
  otlp?: () => OtlpEndpoint | null;
  tickMs?: number;
  /**
   * #449: notes of interrupted builds. With Token saver on, a build of the
   * same work picks up the last interrupted attempt's note.
   */
  runNotes?: RunNotes;
  /** #752: default `uiprofile-learn` beside `buildsDir`. */
  learnDir?: string;
  /** #752: the learn's environment; default the runner's own. */
  env?: Env;
  /** #752: tests replace the learn's process. */
  learnSpawn?: CaptureSpawn;
}

const slotId = (build: BuildRecord): string => `uiprofile:${build.runId}`;

const isTerminal = (phase: PlanTurnPhase): boolean =>
  phase === 'succeeded' || phase === 'failed' || phase === 'cancelled';

/**
 * `uiprofile.build` (docs/specs/223-design-stage.md D13, ADR-0022): one
 * headless, read-only `claude -p --permission-mode plan` in a temporary
 * worktree detached at `origin/<base>`, run by the same `exec-run` as a plan
 * turn with the prompt on stdin. The worktree is removed when the run ends.
 * The runner reports the result text; it never parses it.
 */
export class UiProfileBuildExecutor {
  private readonly tmux: TmuxControl;
  private readonly active = new Map<string, BuildRecord>();
  private readonly queue: string[] = [];
  private readonly preparing = new Set<string>();
  private readonly busy = new Set<string>();
  private ticking = false;
  private cancelTick: Cancel = () => {};
  private offFree: () => void = () => {};

  /** #752: `uiprofile.learn`, in `uiprofile-learn` beside the builds. */
  readonly learner: UiProfileLearner;

  constructor(private readonly options: UiProfileExecutorOptions) {
    this.tmux = new TmuxControl(options.deps.exec, options.tmuxServer ?? []);
    this.learner = new UiProfileLearner({
      deps: options.deps,
      learnDir:
        options.learnDir ?? join(dirname(options.buildsDir), 'uiprofile-learn'),
      env: options.env ?? process.env,
      log: options.log,
      otlp: options.otlp,
      spawn: options.learnSpawn,
    });
  }

  /** Picks up the builds a previous runner left, then starts the timer. */
  async start(): Promise<void> {
    for (const build of this.builds()) {
      if (isTerminal(build.phase)) continue;
      this.active.set(build.runId, build);
      if (build.phase === 'queued') {
        this.queue.push(build.runId);
        continue;
      }
      this.options.slots.tryAcquire(slotId(build));
      if (!build.startedAt) {
        await this.finish(build, {
          phase: 'failed',
          resultTruncated: false,
          error: 'the runner restarted while the build was being prepared',
        });
      }
      // A started build is left to the tick: alive, exited or vanished.
    }
    this.offFree = this.options.slots.onFree(() => this.pump());
    this.pump();
    this.cancelTick = this.options.deps.clock.setInterval(
      () => void this.tick(),
      this.options.tickMs ?? UIPROFILE_TICK_MS,
    );
  }

  stop(): void {
    this.cancelTick();
    this.offFree();
    this.learner.stop();
  }

  /** A build by its `runs` row, for the run log (#183). */
  record(runId: string): BuildRecord | null {
    return this.active.get(runId) ?? this.load(runId);
  }

  /** The build's `stream.jsonl`; an unknown run opens nothing. */
  streamFile(runId: string): string {
    return this.record(runId) ? this.file(runId, 'stream') : '';
  }

  /** `uiprofile.build`: answers once the build is queued or running. */
  async run(raw: UiProfileBuildArgs): Promise<UiProfileBuildResult> {
    const { deps } = this.options;
    const { prompt, ...args } = raw;
    const profile = profileOf(deps, args.profileKey);
    if (profile.runtime !== 'claude') {
      throw new CommandFailure(
        'unsupported_runtime',
        `a UI profile build needs a claude profile; ${profile.id} is ${profile.runtime}`,
      );
    }
    const project = watchedProject(args, deps.watchedProjects());
    if (this.active.has(args.runId) || existsSync(this.dir(args.runId))) {
      throw new CommandFailure(
        'already_exists',
        `build ${args.runId} already exists`,
      );
    }
    const running = [...this.active.values()].find(
      (b) => b.projectId === args.projectId,
    );
    if (running) {
      throw new CommandFailure(
        'busy',
        `project ${args.projectId} already has build ${running.runId} in progress`,
      );
    }
    const fleet = await resolveFleetProject(deps.exec, project);
    const shortId = (deps.shortId ?? randomShortId)();
    // #449: Context handoff is on with Token saver.
    const { runNotes } = this.options;
    const handoffKey =
      runNotes && args.tokenSaver?.enabled
        ? runWorkKey(args.projectId, prompt)
        : undefined;
    const build: BuildRecord = {
      ...args,
      ...(handoffKey ? { handoffKey } : {}),
      shortId,
      repo: fleet.repo,
      worktree: uiProfileWorktreePath(project.root, shortId),
      tmuxSession: uiProfileSessionName(shortId),
      phase: 'queued',
      queuedAt: isoNow(deps.clock),
    };
    const dir = this.dir(build.runId);
    mkdirSync(this.options.buildsDir, { recursive: true, mode: 0o700 });
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch {
      throw new CommandFailure(
        'already_exists',
        `build ${args.runId} already exists`,
      );
    }
    writeFileSync(
      join(dir, PROMPT_FILE),
      runNotes && handoffKey ? runNotes.seed(handoffKey, prompt) : prompt,
      { mode: 0o600 },
    );
    this.save(build);
    this.active.set(build.runId, build);
    this.queue.push(build.runId);
    this.setPhase(build, 'queued');
    this.pump();
    return { phase: build.phase === 'queued' ? 'queued' : 'running' };
  }

  /**
   * `uiprofile.cancel` (#275 D5): a queued build leaves the queue, a preparing
   * one is flagged, a running one loses its session; each ends `cancelled`.
   * A build of another project is `not_found` and keeps going.
   */
  async cancel(args: UiProfileCancelArgs): Promise<UiProfileCancelResult> {
    if (this.record(args.runId)?.projectId !== args.projectId) {
      throw new CommandFailure(
        'not_found',
        `no build ${args.runId} in ${args.projectId}`,
      );
    }
    const live = this.active.get(args.runId);
    if (!live || this.busy.has(args.runId)) return { cancelled: false };
    if (live.phase === 'queued') {
      const at = this.queue.indexOf(live.runId);
      if (at >= 0) this.queue.splice(at, 1);
      await this.finish(live, { phase: 'cancelled', resultTruncated: false });
      return { cancelled: true };
    }
    live.cancelRequested = true;
    this.save(live);
    // Still preparing: `prepare` sees the flag before or after the session starts.
    if (this.preparing.has(live.runId)) return { cancelled: true };
    await this.kill(live);
    await this.end(live, 'cancelled');
    return { cancelled: true };
  }

  /** Checks every running build once: exited, vanished, or over its timeout. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.options.deps.clock.now();
      for (const build of [...this.active.values()]) {
        if (
          build.phase !== 'running' ||
          !build.startedAt ||
          this.busy.has(build.runId) ||
          this.preparing.has(build.runId)
        )
          continue;
        if (this.exit(build)) {
          await this.end(build, 'exited');
          continue;
        }
        if (!(await this.tmux.find(build.tmuxSession))) {
          await this.end(build, this.exit(build) ? 'exited' : 'vanished');
          continue;
        }
        if (now - Date.parse(build.startedAt) >= build.timeoutSec * 1000) {
          await this.kill(build);
          await this.end(build, 'timed_out');
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const runId = this.queue[0] as string;
      const build = this.active.get(runId);
      if (!build || build.phase !== 'queued') {
        this.queue.shift();
        continue;
      }
      if (!this.options.slots.tryAcquire(slotId(build))) return;
      this.queue.shift();
      this.setPhase(build, 'running');
      void this.prepare(build);
    }
  }

  /** The temporary worktree at `origin/<base>`, `run.json`, then the tmux session. */
  private async prepare(build: BuildRecord): Promise<void> {
    const { deps } = this.options;
    const { exec } = deps;
    this.preparing.add(build.runId);
    try {
      // Best effort: an unreachable origin still runs on the base it last fetched.
      await exec(
        'git',
        ['-C', build.root, 'fetch', '--quiet', 'origin', build.base],
        { timeoutMs: NETWORK_TIMEOUT_MS },
      );
      const base = await exec('git', [
        '-C',
        build.root,
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/remotes/origin/${build.base}^{commit}`,
      ]);
      if (!base || base.code !== 0) {
        throw new Error(`origin/${build.base} does not exist`);
      }
      await gitOk(exec, [
        '-C',
        build.root,
        'worktree',
        'add',
        '--quiet',
        '--detach',
        build.worktree,
        base.stdout.trim(),
      ]);
      const profile = profileOf(deps, build.profileKey);
      const spec = uiProfileLaunchSpec(
        profile,
        build,
        build.worktree,
        join(this.dir(build.runId), PROMPT_FILE),
        this.options.otlp?.() ?? null,
        uiProfileTokenSaver(
          profile,
          build,
          deps.home,
          this.dir(build.runId),
          this.options.selfCommand,
        ),
      );
      if (build.cancelRequested) {
        await this.finish(build, {
          phase: 'cancelled',
          resultTruncated: false,
        });
        return;
      }
      writeJsonAtomic(this.file(build.runId, 'launch'), spec);
      build.startedAt = isoNow(deps.clock);
      this.save(build);
      const created = await this.tmux.newSession(
        build.tmuxSession,
        build.worktree,
        [...this.options.selfCommand, 'exec-run', this.dir(build.runId)],
      );
      if (!created.ok) {
        throw new Error(`tmux new-session failed: ${created.stderr}`);
      }
      this.preparing.delete(build.runId);
      if (build.cancelRequested) {
        // Cancelled while the session was being created.
        await this.kill(build);
        await this.end(build, 'cancelled');
      }
    } catch (error) {
      this.options.log.warn('uiprofile: a build failed to start', {
        runId: build.runId,
        error: errorMessage(error),
      });
      await this.finish(build, {
        phase: 'failed',
        resultTruncated: false,
        error: errorMessage(error).slice(0, 2000),
      });
    } finally {
      this.preparing.delete(build.runId);
    }
  }

  private async end(build: BuildRecord, reason: TurnEndReason): Promise<void> {
    if (this.busy.has(build.runId) || !this.active.has(build.runId)) return;
    this.busy.add(build.runId);
    try {
      await this.finish(
        build,
        turnOutcome({
          reason,
          exit: this.exit(build),
          stream: readTail(this.file(build.runId, 'stream'), STREAM_TAIL_BYTES),
          stderr: readTail(this.file(build.runId, 'stderr'), 64 * 1024),
          timeoutSec: build.timeoutSec,
        }),
      );
    } finally {
      this.busy.delete(build.runId);
    }
  }

  /** Removes the worktree, reports the end once, then frees the slot. */
  private async finish(
    build: BuildRecord,
    outcome: ReturnType<typeof turnOutcome>,
  ): Promise<void> {
    await this.removeWorktree(build);
    const at = isoNow(this.options.deps.clock);
    build.finishedAt = at;
    this.active.delete(build.runId);
    this.setPhase(build, outcome.phase);
    // The session id is a plan-turn field; a build has none to report.
    const { sessionId: _session, ...reported } = outcome;
    let data: unknown;
    try {
      data = uiProfileBuildFinishedDataSchema.parse({
        ...this.ref(build),
        ...reported,
        at,
      });
    } catch (error) {
      data = uiProfileBuildFinishedDataSchema.parse({
        ...this.ref(build),
        phase: 'failed',
        at,
        resultTruncated: false,
        error: `cannot report the build: ${errorMessage(error)}`.slice(0, 2000),
      });
    }
    this.emitEvent(build, 'uiprofile_build.finished', data);
    // Released after the event, so the API hears the end before the next start.
    this.options.slots.release(slotId(build));
    this.keepNote(build, outcome.phase);
  }

  /**
   * #449 D2: a build that started and did not succeed leaves a note (haiku,
   * off the slot) for the next attempt at the same work; a success clears it.
   */
  private keepNote(build: BuildRecord, phase: PlanTurnPhase): void {
    const { runNotes } = this.options;
    if (!runNotes || !build.handoffKey) return;
    if (phase === 'succeeded') {
      runNotes.succeeded(build.handoffKey);
      return;
    }
    if (!build.startedAt) return;
    void runNotes.interrupted(
      build,
      build.handoffKey,
      this.dir(build.runId),
      this.file(build.runId, 'stream'),
    );
  }

  private async removeWorktree(build: BuildRecord): Promise<void> {
    if (!existsSync(build.worktree)) return;
    try {
      await gitOk(this.options.deps.exec, [
        '-C',
        build.root,
        'worktree',
        'remove',
        '--force',
        build.worktree,
      ]);
    } catch (error) {
      this.options.log.warn('uiprofile: cannot remove a build worktree', {
        runId: build.runId,
        error: errorMessage(error),
      });
    }
  }

  private ref(build: BuildRecord) {
    return { runId: build.runId, projectId: build.projectId };
  }

  private setPhase(build: BuildRecord, phase: PlanTurnPhase): void {
    build.phase = phase;
    if (existsSync(this.dir(build.runId))) this.save(build);
    const data = uiProfileBuildPhaseChangedDataSchema.parse({
      ...this.ref(build),
      phase,
      at: isoNow(this.options.deps.clock),
    });
    this.emitEvent(build, 'uiprofile_build.phase_changed', data);
  }

  private emitEvent(build: BuildRecord, type: string, data: unknown): void {
    this.options.emit({
      v: 1,
      ts: isoNow(this.options.deps.clock),
      type,
      source: 'runner',
      project: { repo: build.repo, root: build.root },
      data,
    });
  }

  private async kill(build: BuildRecord): Promise<void> {
    try {
      await this.tmux.killSession(build.tmuxSession);
    } catch {
      // Already gone: the end is collected all the same.
    }
  }

  private dir(runId: string): string {
    return join(this.options.buildsDir, skillRunIdSchema.parse(runId));
  }

  private file(runId: string, name: keyof typeof RUN_FILES): string {
    return join(this.dir(runId), RUN_FILES[name]);
  }

  private save(build: BuildRecord): void {
    writeJsonAtomic(this.file(build.runId, 'state'), build);
  }

  private load(runId: string): BuildRecord | null {
    if (!skillRunIdSchema.safeParse(runId).success) return null;
    return readJson(this.file(runId, 'state'), buildRecordSchema);
  }

  private exit(build: BuildRecord): ExitRecord | null {
    return readJson(this.file(build.runId, 'exit'), exitRecordSchema);
  }

  private builds(): BuildRecord[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.options.buildsDir);
    } catch {
      return [];
    }
    return names
      .map((name) => this.load(name))
      .filter((b): b is BuildRecord => b !== null)
      .sort((a, b) =>
        a.queuedAt < b.queuedAt ? -1 : a.queuedAt > b.queuedAt ? 1 : 0,
      );
  }
}
