import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { PREFIX_FILE_MAX_BYTES } from '@nautelle/shared';
import {
  HOOKS_OFF_ENV,
  PREFIX_PROPOSE_INSTRUCTION,
  PREFIX_RESULT_MAX_BYTES,
  type PrefixProposeArgs,
  type PrefixProposeResult,
  type RulesCompressArgs,
  type RulesCompressResult,
  skillRunIdSchema,
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
import { watchedProject } from '../control/target';
import type { Env } from '../env';
import { errorMessage, type Logger } from '../log';
import type { OtlpEndpoint } from '../otlp/token';
import { cutBytes } from '../planner/result';
import { policyFailure, policyRefusal } from '../policy/check';
import type { PolicyConfig } from '../policy/schema';
import { deniedBy, isSecretPath } from '../repo/paths';
import { profileOf, type SkillsDeps } from '../skills/deps';
import { runEnv } from '../skills/run/launch';
import { finalResult } from '../skills/run/stream';
import { sha256Hex } from './measure';
import { overlayOriginalPath } from './overlays';

const PROMPT_FILE = 'prompt.md';

export interface PrefixCallsOptions {
  deps: Pick<SkillsDeps, 'clock' | 'profiles' | 'watchedProjects'>;
  /** The runner-local policy as it is now (ADR-0047): its `code.deny`. */
  policy: () => PolicyConfig;
  /** `<state>/nautelle/prefix-calls`: one directory per run, deleted at its end. */
  dir: string;
  /** The runner's own environment; the profile's overlays it. */
  env: Env;
  log: Logger;
  otlp?: () => OtlpEndpoint | null;
  spawn?: CaptureSpawn;
}

/** One headless call: the run, its profile, its model and its prompt. */
interface Call {
  runId: string;
  projectId: string;
  sessionId: string;
  profileKey: string;
  model: string;
  timeoutSec: number;
  prompt: string;
}

/**
 * #751 B6, B8: `rules.compress` and `prefix.propose` — each one headless
 * `claude -p --tools "" --permission-mode plan` with the prompt on stdin, in
 * a directory of its own outside every watched root and with
 * `NAUTELLE_HOOKS=off`: the `card.assess` pattern (ADR-0032 §1), waiting
 * for the answer as `uiprofile.learn` does. The prompt holds a project's
 * rules or instruction file, so it is deleted when the run ends, and neither
 * it nor the answer is logged.
 */
export class PrefixCalls {
  private readonly active = new Map<string, () => void>();

  constructor(private readonly options: PrefixCallsOptions) {}

  /** Kills what is running; the API fails those runs when the command errors. */
  stop(): void {
    for (const kill of this.active.values()) kill();
  }

  /** B6: the API's prompt as given; the API parses the answer. */
  async compress(args: RulesCompressArgs): Promise<RulesCompressResult> {
    const text = await this.call(args);
    const cut = cutBytes(text, PREFIX_RESULT_MAX_BYTES);
    return { resultText: cut.text, resultTruncated: cut.truncated };
  }

  /**
   * B8: reads the part's file under the watched root, refuses what ADR-0075
   * keeps out — a secret name, a `code.deny` path, a file over 64 KiB — and
   * asks for the shortened file.
   */
  async propose(args: PrefixProposeArgs): Promise<PrefixProposeResult> {
    const project = watchedProject(
      { projectId: args.projectId, root: args.root },
      this.options.deps.watchedProjects(),
    );
    const path = overlayOriginalPath(project.root, args.part);
    if (path === null) {
      throw new CommandFailure('not_found', `no file for ${args.part}`);
    }
    // ADR-0075 §2: a secret name and an oversized file have no policy
    // switch, so their refusal names none.
    if (isSecretPath(path)) {
      throw new CommandFailure(
        'policy_refused',
        `${path} is a secret file; the runner never sends it`,
      );
    }
    const pattern = deniedBy(path, this.options.policy().code.deny);
    if (pattern !== null) {
      throw policyFailure(
        policyRefusal(
          'code.deny',
          `${path} matches the deny-path pattern ${pattern}`,
          pattern,
        ),
      );
    }
    const abs = join(project.root, path);
    if (statSync(abs).size > PREFIX_FILE_MAX_BYTES) {
      throw new CommandFailure(
        'policy_refused',
        `${path} is larger than ${PREFIX_FILE_MAX_BYTES} bytes, the limit of an overlay`,
      );
    }
    const data = readFileSync(abs);
    const originalText = data.toString('utf8');
    const answer = await this.call({
      ...args,
      prompt: `${PREFIX_PROPOSE_INSTRUCTION}\n\n<file path="${path}">\n${originalText}\n</file>\n`,
    });
    if (new TextEncoder().encode(answer).length > PREFIX_FILE_MAX_BYTES) {
      throw new Error(
        `the proposal is larger than ${PREFIX_FILE_MAX_BYTES} bytes`,
      );
    }
    return {
      path,
      originalSha256: sha256Hex(data),
      originalText,
      proposedText: answer,
    };
  }

  private async call(call: Call): Promise<string> {
    const { deps } = this.options;
    const profile = profileOf(deps, call.profileKey);
    if (profile.runtime !== 'claude') {
      throw new CommandFailure(
        'unsupported_runtime',
        `the prefix calls need a claude profile; ${profile.id} is ${profile.runtime}`,
      );
    }
    const projects = deps.watchedProjects();
    if (!projects.some((p) => p.id === call.projectId)) {
      throw new CommandFailure(
        'path_not_allowed',
        `project ${call.projectId} is not watched by this runner`,
      );
    }
    const dir = join(this.options.dir, skillRunIdSchema.parse(call.runId));
    if (projects.some((p) => inside(p.root, dir))) {
      throw new CommandFailure(
        'path_not_allowed',
        'the prefix calls directory is inside a watched project',
      );
    }
    if (this.active.has(call.runId)) {
      throw new CommandFailure(
        'already_exists',
        `run ${call.runId} already exists`,
      );
    }
    mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch {
      throw new CommandFailure(
        'already_exists',
        `run ${call.runId} already exists`,
      );
    }
    try {
      const promptFile = join(dir, PROMPT_FILE);
      writeFileSync(promptFile, call.prompt, { mode: 0o600 });

      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(this.options.env)) {
        if (value !== undefined) env[key] = value;
      }
      Object.assign(env, runEnv(profile, call, this.options.otlp?.() ?? null));
      Object.assign(env, HOOKS_OFF_ENV);

      let proc: CaptureProcess;
      try {
        proc = (this.options.spawn ?? bunSpawn)({
          command: [
            profile.binary ?? profile.runtime,
            ...profile.args,
            ...CAPTURE_CLAUDE_FLAGS,
            '--model',
            call.model,
            '--session-id',
            call.sessionId,
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
      this.active.set(call.runId, () => proc.kill());
      return await this.wait(call, proc);
    } finally {
      this.active.delete(call.runId);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * The answer. A failure throws a plain error, which the command answers as
   * `internal` with its message; the API records it on the run.
   */
  private async wait(call: Call, proc: CaptureProcess): Promise<string> {
    let timedOut = false;
    const cancel: Cancel = this.options.deps.clock.setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, call.timeoutSec * 1000);
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
      // The prompt is a project's text: only the reason is logged.
      this.options.log.warn('prefix: a call failed', {
        runId: call.runId,
        error: errorMessage(error),
      });
      throw new Error(`the call process failed: ${errorMessage(error)}`);
    } finally {
      cancel();
    }
    if (timedOut) {
      throw new Error(`the call exceeded its ${call.timeoutSec} s timeout`);
    }
    if (code !== 0) {
      throw new Error(
        lastLine(stderr) ??
          `the profile binary ended with ${code === null ? 'a signal' : `code ${code}`}`,
      );
    }
    const result = finalResult(stdout);
    if (!result) throw new Error('the call produced no result message');
    if (result.isError) throw new Error('the call ended with an error result');
    if (!result.text) throw new Error('the call gave no answer');
    return result.text;
  }
}
