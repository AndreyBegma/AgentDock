import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOOKS_OFF_ENV } from '@nautelle/shared/protocol';
import {
  bunSpawn,
  CAPTURE_CLAUDE_FLAGS,
  type CaptureSpawn,
} from '../capture/executor';
import type { Clock } from '../clock';
import type { ConfigProfile } from '../config';
import type { Env } from '../env';
import { errorMessage, type Logger } from '../log';
import type { OtlpEndpoint } from '../otlp/token';
import { runEnv } from '../skills/run/launch';
import { finalResult } from '../skills/run/stream';
import { oneLine } from './emit';

/** D3: the model of the local classifier. */
export const STEWARD_CLASSIFIER_MODEL = 'haiku';
/** One classification gives up after this long. */
export const STEWARD_CLASSIFIER_TIMEOUT_MS = 60_000;

const PROMPT_FILE = 'prompt.md';

/** What the classifier is asked; the redacted pane tail follows it. */
export const classifierPrompt = (tail: string, silentMinutes: number): string =>
  [
    `An AI coding agent's terminal session has shown no activity for ${silentMinutes} minutes, and no known rule explains it.`,
    'Below is the end of its terminal. In one line of at most 150 characters, say what the session is stuck on or waiting for — for example "a wait loop polls pgrep -f and matches itself" or "a test run has hung on a database connection".',
    'Answer with that line only: no preamble, no quotes, no advice.',
    '',
    '<terminal>',
    tail,
    '</terminal>',
  ].join('\n');

export interface StewardClassification {
  reason: string;
  /** The Claude session of the call (D16): the API books its spend. */
  sessionId: string;
}

export interface StewardClassifierOptions {
  /** `$XDG_STATE_HOME/nautelle/steward`: one directory per call, deleted at its end. */
  dir: string;
  env: Env;
  clock: Clock;
  log: Logger;
  otlp?: () => OtlpEndpoint | null;
  spawn?: CaptureSpawn;
  timeoutMs?: number;
}

/**
 * D3: an unknown stall classified by haiku, run locally on the subject's own
 * profile — one headless `claude -p --tools "" --permission-mode plan` with
 * the prompt on stdin, in a directory of its own, with `NAUTELLE_HOOKS=off`
 * so the call never becomes a captured session. The prompt carries pane
 * text, so its file is deleted when the call ends and neither is logged.
 * Resolves `null` on any failure: the caller falls back to its rule.
 */
export class StewardClassifier {
  constructor(private readonly options: StewardClassifierOptions) {}

  async classify(
    profile: ConfigProfile,
    projectId: string,
    tail: string,
    silentMinutes: number,
  ): Promise<StewardClassification | null> {
    if (profile.runtime !== 'claude') return null;
    const sessionId = randomUUID();
    const dir = join(this.options.dir, sessionId);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const promptFile = join(dir, PROMPT_FILE);
      writeFileSync(promptFile, classifierPrompt(tail, silentMinutes), {
        mode: 0o600,
      });
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(this.options.env)) {
        if (value !== undefined) env[key] = value;
      }
      Object.assign(
        env,
        runEnv(
          profile,
          { projectId, runId: sessionId },
          this.options.otlp?.() ?? null,
        ),
      );
      // The call is no run of the API's: only the project is attributed;
      // the API books it by `classifierSessionId` (D16).
      env.OTEL_RESOURCE_ATTRIBUTES = `agentdock.project=${projectId.replace(
        /[^A-Za-z0-9_.-]/g,
        (c) => encodeURIComponent(c),
      )}`;
      Object.assign(env, HOOKS_OFF_ENV);
      const proc = (this.options.spawn ?? bunSpawn)({
        command: [
          profile.binary ?? profile.runtime,
          ...profile.args,
          ...CAPTURE_CLAUDE_FLAGS,
          '--model',
          STEWARD_CLASSIFIER_MODEL,
          '--session-id',
          sessionId,
        ],
        cwd: dir,
        env,
        stdinFile: promptFile,
      });
      const cancel = this.options.clock.setTimeout(
        () => proc.kill(),
        this.options.timeoutMs ?? STEWARD_CLASSIFIER_TIMEOUT_MS,
      );
      try {
        const [code, stdout] = await Promise.all([
          proc.exited,
          proc.stdout,
          proc.stderr,
        ]);
        if (code !== 0) return null;
        const result = finalResult(stdout);
        if (!result?.text || result.isError) return null;
        const first =
          result.text.split('\n').find((l) => l.trim().length > 0) ?? '';
        const reason = oneLine(first.replace(/^["'`]+|["'`]+$/g, ''), '');
        return reason ? { reason, sessionId } : null;
      } finally {
        cancel();
      }
    } catch (error) {
      this.options.log.warn('steward: the classifier failed', {
        projectId,
        error: errorMessage(error),
      });
      return null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
