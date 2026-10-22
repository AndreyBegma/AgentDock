import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { CAPTURE_RESULT_MAX_BYTES } from '@nautelle/shared';
import {
  CAPTURE_EXTRACT_ERROR_MAX,
  type CardsExtractArgs,
  type CardsExtractFinishedData,
  type CardsExtractResult,
  cardsExtractFinishedDataSchema,
  HOOKS_OFF_ENV,
  skillRunIdSchema,
  type UnsequencedEvent,
} from '@nautelle/shared/protocol';
import { type Cancel, isoNow } from '../clock';
import { CommandFailure } from '../commands/failure';
import type { Env } from '../env';
import { resolveFleetProject } from '../fleet/project';
import {
  type TextCallLaunchOptions,
  textCallTokenSaver,
} from '../launch/token-saver';
import { errorMessage, type Logger } from '../log';
import { redact } from '../pane/redact';
import { cutBytes } from '../planner/result';
import { profileOf, type SkillsDeps } from '../skills/deps';
import { runEnv } from '../skills/run/launch';
import { finalResult } from '../skills/run/stream';

const PROMPT_FILE = 'prompt.md';

/**
 * The flags that make an extraction a pure text-in, text-out call (issue #244
 * D4). `claude --help` on this host: `--tools <tools...>` "Use "" to disable
 * all tools" — an empty argument, so the model has nothing to call, on top of
 * `--permission-mode plan`. `--bare` is not used: it also skips the keychain,
 * and a profile may authenticate through it.
 */
export const CAPTURE_CLAUDE_FLAGS = [
  '-p',
  '--tools',
  '',
  '--permission-mode',
  'plan',
  '--output-format',
  'stream-json',
  '--verbose',
] as const;

/** What the executor needs of the child process; tests run a fake `claude`. */
export interface CaptureProcess {
  /** The exit code, or null when a signal ended it. */
  exited: Promise<number | null>;
  stdout: Promise<string>;
  stderr: Promise<string>;
  kill(): void;
}

export type CaptureSpawn = (spec: {
  command: readonly string[];
  cwd: string;
  env: Record<string, string>;
  stdinFile: string;
}) => CaptureProcess;

/**
 * The most of stdout kept: the final `result` message, at most
 * `CAPTURE_RESULT_MAX_BYTES` of text, is its last line, so a tail this long
 * holds it with room to spare. stderr is only read for its last line.
 */
export const CAPTURE_STDOUT_MAX_BYTES = 8 * 1024 * 1024;
export const CAPTURE_STDERR_MAX_BYTES = 64 * 1024;

/**
 * The last `maxBytes` of `stream`, as text: whatever came before is dropped as
 * it arrives, so a child that writes without end never grows the runner.
 */
export const readTail = async (
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string> => {
  const chunks: Uint8Array[] = [];
  let held = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    held += chunk.length;
    while (held - (chunks[0]?.length ?? 0) >= maxBytes) {
      held -= chunks.shift()?.length ?? 0;
    }
  }
  const all = Buffer.concat(chunks);
  return all.subarray(Math.max(0, all.length - maxBytes)).toString('utf8');
};

export const bunSpawn: CaptureSpawn = ({ command, cwd, env, stdinFile }) => {
  const proc = Bun.spawn([...command], {
    cwd,
    env,
    stdin: Bun.file(stdinFile),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exited: proc.exited.then((code) => (proc.signalCode ? null : code)),
    stdout: readTail(proc.stdout, CAPTURE_STDOUT_MAX_BYTES),
    stderr: readTail(proc.stderr, CAPTURE_STDERR_MAX_BYTES),
    kill: () => proc.kill('SIGKILL'),
  };
};

export interface CaptureExecutorOptions extends TextCallLaunchOptions {
  deps: Pick<SkillsDeps, 'exec' | 'clock' | 'profiles' | 'watchedProjects'>;
  /** `$XDG_STATE_HOME/nautelle/capture`: one directory per extraction, deleted at its end. */
  capturesDir: string;
  /** The runner's own environment; the profile's overlays it. */
  env: Env;
  emit: (event: UnsequencedEvent) => void;
  log: Logger;
  otlpPort?: () => number | null;
  spawn?: CaptureSpawn;
}

interface Extraction {
  args: CardsExtractArgs;
  repo: string;
  root: string;
  kill: () => void;
}

export const lastLine = (stderr: string): string | null => {
  const last = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  return last ? (redact([last])[0] ?? '').slice(0, 300) : null;
};

export const inside = (root: string, path: string): boolean => {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..');
};

/**
 * `cards.extract` (issue #244 D4, ADR-0026): one headless
 * `claude -p --tools "" --permission-mode plan` with the prompt on stdin, run
 * in a directory of its own outside every watched root and with
 * `NAUTELLE_HOOKS=off`, so the extraction never becomes a session that is
 * itself captured. The runner reports the final `result` text and never
 * parses it. The prompt carries session content, so the file is deleted when
 * the run ends and neither the prompt nor the result is ever logged.
 *
 * An extraction does not survive a runner restart: the API's retry (D7)
 * covers it. One runs per project at a time (D7); the API enforces the rest.
 */
export class CaptureExecutor {
  private readonly active = new Map<string, Extraction>();

  constructor(private readonly options: CaptureExecutorOptions) {}

  /** Kills what is running; nothing is reported — the connection is going away. */
  stop(): void {
    for (const extraction of this.active.values()) extraction.kill();
  }

  async run(args: CardsExtractArgs): Promise<CardsExtractResult> {
    const { deps } = this.options;
    const profile = profileOf(deps, args.profileKey);
    if (profile.runtime !== 'claude') {
      throw new CommandFailure(
        'unsupported_runtime',
        `card capture needs a claude profile; ${profile.id} is ${profile.runtime}`,
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
      this.options.capturesDir,
      skillRunIdSchema.parse(args.runId),
    );
    if (projects.some((p) => inside(p.root, dir))) {
      throw new CommandFailure(
        'path_not_allowed',
        'the capture directory is inside a watched project',
      );
    }
    if (this.active.has(args.runId)) {
      throw new CommandFailure(
        'already_exists',
        `extraction ${args.runId} already exists`,
      );
    }
    const running = [...this.active.values()].find(
      (e) => e.args.projectId === args.projectId,
    );
    if (running) {
      throw new CommandFailure(
        'busy',
        `project ${args.projectId} already has extraction ${running.args.runId} in progress`,
      );
    }
    const fleet = await resolveFleetProject(deps.exec, project);

    mkdirSync(this.options.capturesDir, { recursive: true, mode: 0o700 });
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch {
      throw new CommandFailure(
        'already_exists',
        `extraction ${args.runId} already exists`,
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
    Object.assign(env, HOOKS_OFF_ENV);
    // #445: off or absent launches exactly as before.
    const tokenSaver = textCallTokenSaver(
      this.options,
      profile,
      args,
      dir,
      'card_capture',
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
    const extraction: Extraction = {
      args,
      repo: fleet.repo,
      root: project.root,
      kill: () => proc.kill(),
    };
    this.active.set(args.runId, extraction);
    void this.watch(extraction, proc, dir);
    return { phase: 'running' };
  }

  /** Waits for the end, reports it once, deletes the run directory. */
  private async watch(
    extraction: Extraction,
    proc: CaptureProcess,
    dir: string,
  ): Promise<void> {
    const { args } = extraction;
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
        extraction,
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
      this.options.log.warn('capture: an extraction failed', {
        runId: args.runId,
        error: errorMessage(error),
      });
      this.finish(extraction, {
        ok: false,
        resultTruncated: false,
        error: `the extraction process failed: ${errorMessage(error)}`,
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
      ? cutBytes(result.text, CAPTURE_RESULT_MAX_BYTES)
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
      return failed(`the extraction exceeded its ${timeoutSec} s timeout`);
    }
    if (code !== 0) {
      return failed(
        lastLine(stderr) ??
          `the profile binary ended with ${code === null ? 'a signal' : `code ${code}`}`,
      );
    }
    if (!result) return failed('the extraction produced no result message');
    if (result.isError)
      return failed('the extraction ended with an error result');
    return { ...base, ok: true };
  }

  private finish(extraction: Extraction, outcome: Outcome): void {
    const { args } = extraction;
    this.active.delete(args.runId);
    const { clock } = this.options.deps;
    const at = isoNow(clock);
    let data: CardsExtractFinishedData;
    try {
      data = cardsExtractFinishedDataSchema.parse({
        runId: args.runId,
        projectId: args.projectId,
        at,
        ...outcome,
        ...(outcome.error
          ? { error: outcome.error.slice(0, CAPTURE_EXTRACT_ERROR_MAX) }
          : {}),
      });
    } catch (error) {
      data = cardsExtractFinishedDataSchema.parse({
        runId: args.runId,
        projectId: args.projectId,
        at,
        ok: false,
        resultTruncated: false,
        error: `cannot report the extraction: ${errorMessage(error)}`.slice(
          0,
          CAPTURE_EXTRACT_ERROR_MAX,
        ),
      });
    }
    this.options.emit({
      v: 1,
      ts: at,
      type: 'cards_extract.finished',
      source: 'runner',
      project: { repo: extraction.repo, root: extraction.root },
      data,
    });
  }
}

interface Outcome {
  ok: boolean;
  exitCode?: number;
  result?: string;
  resultTruncated: boolean;
  error?: string;
}
