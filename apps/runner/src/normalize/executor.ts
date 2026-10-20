import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEXT_ERROR_MAX, TEXT_RESULT_MAX_BYTES } from '@nautelle/shared';
import {
  AGENTDOCK_HOOKS_ENV,
  AGENTDOCK_HOOKS_OFF,
  skillRunIdSchema,
  type TextNormalizeArgs,
  type TextNormalizeFinishedData,
  type TextNormalizeResult,
  textNormalizeFinishedDataSchema,
  type UnsequencedEvent,
} from '@nautelle/shared/protocol';
import {
  bunSpawn,
  CAPTURE_CLAUDE_FLAGS,
  type CaptureProcess,
  type CaptureSpawn,
  inside,
  lastLine,
} from '../capture/executor';
import { type Cancel, isoNow } from '../clock';
import { CommandFailure } from '../commands/failure';
import type { Env } from '../env';
import { resolveFleetProject } from '../fleet/project';
import {
  type TextCallLaunchOptions,
  textCallTokenSaver,
} from '../launch/token-saver';
import { errorMessage, type Logger } from '../log';
import { cutBytes } from '../planner/result';
import { profileOf, type SkillsDeps } from '../skills/deps';
import { runEnv } from '../skills/run/launch';
import { finalResult } from '../skills/run/stream';

const PROMPT_FILE = 'prompt.md';

export interface NormalizeExecutorOptions extends TextCallLaunchOptions {
  deps: Pick<SkillsDeps, 'exec' | 'clock' | 'profiles' | 'watchedProjects'>;
  /** `$XDG_STATE_HOME/agentdock/normalize`: one directory per run, deleted at its end. */
  normalizeDir: string;
  /** The runner's own environment; the profile's overlays it. */
  env: Env;
  emit: (event: UnsequencedEvent) => void;
  log: Logger;
  otlpPort?: () => number | null;
  spawn?: CaptureSpawn;
}

interface Normalization {
  args: TextNormalizeArgs;
  repo: string;
  root: string;
  kill: () => void;
}

interface Outcome {
  ok: boolean;
  exitCode?: number;
  result?: string;
  resultTruncated: boolean;
  error?: string;
}

/**
 * `text.normalize` (issue #271 D4, ADR-0027): one headless
 * `claude -p --tools "" --permission-mode plan` with the prompt on stdin, run
 * in a directory of its own outside every watched root and with
 * `AGENTDOCK_HOOKS=off`, so a translation never becomes a captured session.
 * The runner reports the final `result` text and never parses it. The prompt
 * carries what a person typed, so the file is deleted when the run ends and
 * neither the prompt nor the result is ever logged.
 *
 * A run does not survive a runner restart: the API's retry (D11) covers it.
 * The API limits concurrency per project (D11); the runner refuses only a
 * repeated run id.
 */
export class NormalizeExecutor {
  private readonly active = new Map<string, Normalization>();

  constructor(private readonly options: NormalizeExecutorOptions) {}

  /** Kills what is running; nothing is reported — the connection is going away. */
  stop(): void {
    for (const run of this.active.values()) run.kill();
  }

  async run(args: TextNormalizeArgs): Promise<TextNormalizeResult> {
    const { deps } = this.options;
    const profile = profileOf(deps, args.profileKey);
    if (profile.runtime !== 'claude') {
      throw new CommandFailure(
        'unsupported_runtime',
        `text normalization needs a claude profile; ${profile.id} is ${profile.runtime}`,
      );
    }
    const projects = deps.watchedProjects();
    const project = projects.find((p) => p.id === args.projectId);
    if (!project) {
      throw new CommandFailure(
        'path_not_allowed',
        `project ${args.projectId} is not watched by this runner`,
      );
    }
    const dir = join(
      this.options.normalizeDir,
      skillRunIdSchema.parse(args.runId),
    );
    if (projects.some((p) => inside(p.root, dir))) {
      throw new CommandFailure(
        'path_not_allowed',
        'the normalization directory is inside a watched project',
      );
    }
    if (this.active.has(args.runId)) {
      throw new CommandFailure(
        'already_exists',
        `normalization ${args.runId} already exists`,
      );
    }
    const fleet = await resolveFleetProject(deps.exec, project);

    mkdirSync(this.options.normalizeDir, { recursive: true, mode: 0o700 });
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch {
      throw new CommandFailure(
        'already_exists',
        `normalization ${args.runId} already exists`,
      );
    }
    const promptFile = join(dir, PROMPT_FILE);
    writeFileSync(promptFile, args.prompt, { mode: 0o600 });

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.options.env)) {
      if (value !== undefined) env[key] = value;
    }
    Object.assign(
      env,
      runEnv(profile, args, this.options.otlpPort?.() ?? null),
    );
    env[AGENTDOCK_HOOKS_ENV] = AGENTDOCK_HOOKS_OFF;
    // #445: off or absent launches exactly as before.
    const tokenSaver = textCallTokenSaver(
      this.options,
      profile,
      args,
      dir,
      'text_normalize',
    );
    Object.assign(env, tokenSaver?.env ?? {});

    let proc: CaptureProcess;
    try {
      proc = (this.options.spawn ?? bunSpawn)({
        command: [
          profile.binary ?? profile.runtime,
          ...profile.args,
          ...(tokenSaver?.args ?? []),
          ...CAPTURE_CLAUDE_FLAGS,
          '--model',
          args.model,
          '--session-id',
          args.sessionId,
        ],
        cwd: dir,
        env,
        stdinFile: promptFile,
      });
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw new CommandFailure(
        'unsupported',
        `cannot start ${profile.binary ?? profile.runtime}: ${errorMessage(error)}`.slice(
          0,
          300,
        ),
      );
    }
    const run: Normalization = {
      args,
      repo: fleet.repo,
      root: project.root,
      kill: () => proc.kill(),
    };
    this.active.set(args.runId, run);
    void this.watch(run, proc, dir);
    return { phase: 'running' };
  }

  /** Waits for the end, reports it once, deletes the run directory. */
  private async watch(
    run: Normalization,
    proc: CaptureProcess,
    dir: string,
  ): Promise<void> {
    const { args } = run;
    const { clock } = this.options.deps;
    let timedOut = false;
    const cancel: Cancel = clock.setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, args.timeoutSec * 1000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        proc.stdout,
        proc.stderr,
      ]);
      cancel();
      this.finish(
        run,
        this.outcome({
          code,
          stdout,
          stderr,
          timedOut,
          timeoutSec: args.timeoutSec,
        }),
      );
    } catch (error) {
      cancel();
      this.options.log.warn('normalize: a run failed', {
        runId: args.runId,
        error: errorMessage(error),
      });
      this.finish(run, {
        ok: false,
        resultTruncated: false,
        error: `the normalization process failed: ${errorMessage(error)}`,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private outcome(input: {
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    timeoutSec: number;
  }): Outcome {
    const { code, stdout, stderr, timedOut, timeoutSec } = input;
    const result = finalResult(stdout);
    const cut = result?.text
      ? cutBytes(result.text, TEXT_RESULT_MAX_BYTES)
      : null;
    const base = {
      ...(code === null ? {} : { exitCode: code }),
      ...(cut ? { result: cut.text } : {}),
      resultTruncated: cut?.truncated ?? false,
    };
    const failed = (error: string): Outcome => ({
      ...base,
      ok: false,
      error,
    });
    if (timedOut) {
      return failed(`the normalization exceeded its ${timeoutSec} s timeout`);
    }
    if (code !== 0) {
      return failed(
        lastLine(stderr) ??
          `the profile binary ended with ${code === null ? 'a signal' : `code ${code}`}`,
      );
    }
    if (!result) return failed('the normalization produced no result message');
    if (result.isError) {
      return failed('the normalization ended with an error result');
    }
    return { ...base, ok: true };
  }

  private finish(run: Normalization, outcome: Outcome): void {
    const { args } = run;
    this.active.delete(args.runId);
    const { clock } = this.options.deps;
    const at = isoNow(clock);
    let data: TextNormalizeFinishedData;
    try {
      data = textNormalizeFinishedDataSchema.parse({
        runId: args.runId,
        projectId: args.projectId,
        at,
        ...outcome,
        ...(outcome.error
          ? { error: outcome.error.slice(0, TEXT_ERROR_MAX) }
          : {}),
      });
    } catch (error) {
      data = textNormalizeFinishedDataSchema.parse({
        runId: args.runId,
        projectId: args.projectId,
        at,
        ok: false,
        resultTruncated: false,
        error: `cannot report the normalization: ${errorMessage(error)}`.slice(
          0,
          TEXT_ERROR_MAX,
        ),
      });
    }
    this.options.emit({
      v: 1,
      ts: at,
      type: 'text_normalize.finished',
      source: 'runner',
      project: { repo: run.repo, root: run.root },
      data,
    });
  }
}
