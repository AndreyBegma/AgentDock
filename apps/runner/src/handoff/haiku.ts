import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HANDOFF_NOTE_MAX_TOKENS,
  HANDOFF_NOTE_TEMPLATE,
} from '@nautelle/shared';
import {
  AGENTDOCK_HOOKS_ENV,
  AGENTDOCK_HOOKS_OFF,
} from '@nautelle/shared/protocol';
import {
  bunSpawn,
  CAPTURE_CLAUDE_FLAGS,
  type CaptureSpawn,
} from '../capture/executor';
import type { Clock } from '../clock';
import type { ConfigProfile } from '../config';
import type { Env } from '../env';
import { errorMessage, type Logger } from '../log';
import { runEnv } from '../skills/run/launch';
import { finalResult } from '../skills/run/stream';

/** D2: the model that writes a dead session's note. */
export const HANDOFF_WRITER_MODEL = 'haiku';
/** One note gives up after this long. */
export const HANDOFF_WRITER_TIMEOUT_MS = 120_000;

const PROMPT_FILE = 'prompt.md';

/** What haiku is asked: the template, the old note and the transcript text. */
export const handoffWriterPrompt = (
  excerpt: string,
  previous: string | null,
): string =>
  [
    'An AI coding agent worked on a task in the session whose transcript is below, and the session ended before it updated its handoff note. Write the note the next session needs to continue without re-learning the task.',
    `Answer with the note only, in markdown, with exactly these "## " sections in this order and nothing else: the template below. Under each, short bullet points; "none" when there is nothing to say. "Goal" says in a line or two what the work is for; "Next" is an ordered list; "Dead ends" says what was tried and why it did not work. At most ${HANDOFF_NOTE_MAX_TOKENS} tokens.`,
    'If the previous note has lines ending with "<!-- person -->", copy each of them word for word, mark included, into the same section.',
    '',
    '<template>',
    HANDOFF_NOTE_TEMPLATE.trimEnd(),
    '</template>',
    '',
    '<previous-note>',
    previous?.trimEnd() || '(none)',
    '</previous-note>',
    '',
    '<transcript>',
    excerpt,
    '</transcript>',
  ].join('\n');

/** Drops a ```markdown fence the model may wrap the note in. */
export const unwrapNote = (text: string): string => {
  const trimmed = text.trim();
  const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
};

export interface HandoffWriterOptions {
  /** `$XDG_STATE_HOME/agentdock/handoff`: one directory per call, deleted at its end. */
  dir: string;
  env: Env;
  clock: Clock;
  log: Logger;
  otlpPort?: () => number | null;
  spawn?: CaptureSpawn;
  timeoutMs?: number;
}

/**
 * D2: a dead session's note, written by haiku from its transcript, locally on
 * the round's own profile — the `StewardClassifier` precedent: one headless
 * `claude -p --tools ""` with the prompt on stdin, in a directory of its own,
 * with `AGENTDOCK_HOOKS=off`. The prompt carries session content, so its file
 * is deleted when the call ends and neither is logged. Resolves `null` on any
 * failure; the caller validates what it gets like any other note.
 */
export class HandoffWriter {
  constructor(private readonly options: HandoffWriterOptions) {}

  async write(
    profile: ConfigProfile,
    projectId: string,
    excerpt: string,
    previous: string | null,
  ): Promise<string | null> {
    if (profile.runtime !== 'claude') return null;
    const sessionId = randomUUID();
    const dir = join(this.options.dir, sessionId);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const promptFile = join(dir, PROMPT_FILE);
      writeFileSync(promptFile, handoffWriterPrompt(excerpt, previous), {
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
          this.options.otlpPort?.() ?? null,
        ),
      );
      // No run of the API's: only the project is attributed.
      env.OTEL_RESOURCE_ATTRIBUTES = `agentdock.project=${projectId.replace(
        /[^A-Za-z0-9_.-]/g,
        (c) => encodeURIComponent(c),
      )}`;
      env[AGENTDOCK_HOOKS_ENV] = AGENTDOCK_HOOKS_OFF;
      const proc = (this.options.spawn ?? bunSpawn)({
        command: [
          profile.binary ?? profile.runtime,
          ...profile.args,
          ...CAPTURE_CLAUDE_FLAGS,
          '--model',
          HANDOFF_WRITER_MODEL,
          '--session-id',
          sessionId,
        ],
        cwd: dir,
        env,
        stdinFile: promptFile,
      });
      const cancel = this.options.clock.setTimeout(
        () => proc.kill(),
        this.options.timeoutMs ?? HANDOFF_WRITER_TIMEOUT_MS,
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
        return unwrapNote(result.text);
      } finally {
        cancel();
      }
    } catch (error) {
      this.options.log.warn('handoff: haiku could not write the note', {
        projectId,
        error: errorMessage(error),
      });
      return null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
