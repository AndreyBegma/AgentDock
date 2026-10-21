import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UIPROFILE_LEARN_RESULT_MAX_BYTES } from '@nautelle/shared';
import {
  HOOKS_OFF_ENV,
  skillRunIdSchema,
  type UiProfileLearnArgs,
  type UiProfileLearnResult,
} from '@nautelle/shared/protocol';
import {
  bunSpawn,
  CAPTURE_CLAUDE_FLAGS,
  type CaptureProcess,
  type CaptureSpawn,
  inside,
  lastLine,
} from '../capture/executor';
import type { Cancel } from '../clock';
import { CommandFailure } from '../commands/failure';
import type { Env } from '../env';
import { errorMessage, type Logger } from '../log';
import { cutBytes } from '../planner/result';
import { profileOf, type SkillsDeps } from '../skills/deps';
import { runEnv } from '../skills/run/launch';
import { finalResult } from '../skills/run/stream';

const PROMPT_FILE = 'prompt.md';

export interface UiProfileLearnerOptions {
  deps: Pick<SkillsDeps, 'clock' | 'profiles' | 'watchedProjects'>;
  /** `$XDG_STATE_HOME/nautelle/uiprofile-learn`: one directory per run, deleted at its end. */
  learnDir: string;
  /** The runner's own environment; the profile's overlays it. */
  env: Env;
  log: Logger;
  otlpPort?: () => number | null;
  spawn?: CaptureSpawn;
}

/**
 * `uiprofile.learn` (#752 A2, ADR-0075 §6): one headless
 * `claude -p --tools "" --permission-mode plan` with the prompt on stdin, in
 * a directory of its own outside every watched root and with
 * `NAUTELLE_HOOKS=off` — the `card.assess` pattern (ADR-0032 §1). It waits
 * for the answer and returns the final `result` text, as `code.ask` does; it
 * never parses it. The prompt carries a design's HTML and comments, so the
 * file is deleted when the run ends, and neither it nor the answer is logged.
 */
export class UiProfileLearner {
  private readonly active = new Map<string, () => void>();

  constructor(private readonly options: UiProfileLearnerOptions) {}

  /** Kills what is running; the API fails those runs when the command errors. */
  stop(): void {
    for (const kill of this.active.values()) kill();
  }

  async learn(args: UiProfileLearnArgs): Promise<UiProfileLearnResult> {
    const { deps } = this.options;
    const profile = profileOf(deps, args.profileKey);
    if (profile.runtime !== 'claude') {
      throw new CommandFailure(
        'unsupported_runtime',
        `profile learning needs a claude profile; ${profile.id} is ${profile.runtime}`,
      );
    }
    const projects = deps.watchedProjects();
    if (!projects.some((p) => p.id === args.projectId)) {
      throw new CommandFailure(
        'path_not_allowed',
        `project ${args.projectId} is not watched by this runner`,
      );
    }
    const dir = join(this.options.learnDir, skillRunIdSchema.parse(args.runId));
    if (projects.some((p) => inside(p.root, dir))) {
      throw new CommandFailure(
        'path_not_allowed',
        'the learn directory is inside a watched project',
      );
    }
    if (this.active.has(args.runId)) {
      throw new CommandFailure(
        'already_exists',
        `learn ${args.runId} already exists`,
      );
    }
    mkdirSync(this.options.learnDir, { recursive: true, mode: 0o700 });
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch {
      throw new CommandFailure(
        'already_exists',
        `learn ${args.runId} already exists`,
      );
    }
    try {
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
      Object.assign(env, HOOKS_OFF_ENV);

      let proc: CaptureProcess;
      try {
        proc = (this.options.spawn ?? bunSpawn)({
          command: [
            profile.binary ?? profile.runtime,
            ...profile.args,
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
        throw new CommandFailure(
          'unsupported',
          `cannot start ${profile.binary ?? profile.runtime}: ${errorMessage(error)}`.slice(
            0,
            300,
          ),
        );
      }
      this.active.set(args.runId, () => proc.kill());
      return await this.wait(args, proc);
    } finally {
      this.active.delete(args.runId);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * The answer. A failure throws a plain error, which the command answers as
   * `internal` with its message; the API records it on the run.
   */
  private async wait(
    args: UiProfileLearnArgs,
    proc: CaptureProcess,
  ): Promise<UiProfileLearnResult> {
    let timedOut = false;
    const cancel: Cancel = this.options.deps.clock.setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, args.timeoutSec * 1000);
    let code: number | null;
    let stdout: string;
    let stderr: string;
    try {
      [code, stdout, stderr] = await Promise.all([
        proc.exited,
        proc.stdout,
        proc.stderr,
      ]);
    } catch (error) {
      // The prompt is a design's text: only the reason is logged.
      this.options.log.warn('uiprofile: a learn failed', {
        runId: args.runId,
        error: errorMessage(error),
      });
      throw new Error(`the learn process failed: ${errorMessage(error)}`);
    } finally {
      cancel();
    }
    if (timedOut) {
      throw new Error(`the learn exceeded its ${args.timeoutSec} s timeout`);
    }
    if (code !== 0) {
      throw new Error(
        lastLine(stderr) ??
          `the profile binary ended with ${code === null ? 'a signal' : `code ${code}`}`,
      );
    }
    const result = finalResult(stdout);
    if (!result) throw new Error('the learn produced no result message');
    if (result.isError) throw new Error('the learn ended with an error result');
    if (!result.text) throw new Error('the learn gave no answer');
    const cut = cutBytes(result.text, UIPROFILE_LEARN_RESULT_MAX_BYTES);
    return { resultText: cut.text, resultTruncated: cut.truncated };
  }
}
