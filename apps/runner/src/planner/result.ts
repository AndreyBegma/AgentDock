import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import {
  PLAN_TURN_ERROR_MAX,
  PLAN_TURN_RESULT_MAX_BYTES,
  type PlanTurnTerminalPhase,
  planSessionIdSchema,
} from '@agentdock/shared/protocol';
import { redact } from '../pane/redact';
import type { ExitRecord } from '../skills/run/record';
import { finalResult } from '../skills/run/stream';

/** A stream larger than this is read from its tail for the final `result`. */
export const STREAM_TAIL_BYTES = 8 * 1024 * 1024;

/** Why the turn's session is over. */
export type TurnEndReason = 'exited' | 'vanished' | 'cancelled' | 'timed_out';

/** The last `max` bytes of a file; `''` when it cannot be read. */
export const readTail = (path: string, max: number): string => {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return '';
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, max);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, size - length);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
};

const encoder = new TextEncoder();

/** `text` cut to at most `max` UTF-8 bytes, never mid-character. */
export const cutBytes = (
  text: string,
  max: number,
): { text: string; truncated: boolean } => {
  const bytes = encoder.encode(text);
  if (bytes.length <= max) return { text, truncated: false };
  let end = max;
  // Back off continuation bytes (10xxxxxx) to a character boundary.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return {
    text: new TextDecoder().decode(bytes.subarray(0, end)),
    truncated: true,
  };
};

/**
 * The session the turn ran in, as the CLI reports it in its `system/init`
 * line — for a fork, the fork's. The last init line wins.
 */
export const streamSessionId = (stream: string): string | null => {
  const lines = stream.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const message: unknown = JSON.parse(line);
      if (
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: unknown }).type === 'system' &&
        (message as { subtype?: unknown }).subtype === 'init'
      ) {
        const id = planSessionIdSchema.safeParse(
          (message as { session_id?: unknown }).session_id,
        );
        return id.success ? id.data : null;
      }
    } catch {
      // Not JSON: the CLI's stray output, skipped.
    }
  }
  return null;
};

const lastStderrLine = (stderr: string): string | null => {
  const last = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  return last ? (redact([last])[0] ?? '').slice(0, 300) : null;
};

export interface TurnOutcome {
  phase: PlanTurnTerminalPhase;
  exitCode?: number;
  sessionId?: string;
  resultText?: string;
  resultTruncated: boolean;
  error?: string;
}

/**
 * D17: the runner reports the final `result` text and the session id; it
 * never parses the planner's block. A turn fails on a non-zero exit, a
 * missing result or an error result, and the result text is kept either way.
 */
export const turnOutcome = (input: {
  reason: TurnEndReason;
  exit: ExitRecord | null;
  stream: string;
  stderr: string;
  timeoutSec: number;
  /** The session the turn was started in; absent when it never started. */
  fallbackSessionId?: string;
}): TurnOutcome => {
  const { reason, exit } = input;
  const result = finalResult(input.stream);
  const cut = result?.text
    ? cutBytes(result.text, PLAN_TURN_RESULT_MAX_BYTES)
    : null;
  let phase: PlanTurnTerminalPhase = 'failed';
  let error: string | undefined;
  if (reason === 'cancelled') phase = 'cancelled';
  else if (reason === 'timed_out') {
    error = `the turn exceeded its ${input.timeoutSec} s timeout`;
  } else if (reason === 'vanished' || exit === null) {
    error = 'the session ended without an exit status';
  } else if (exit.code !== 0) {
    error =
      lastStderrLine(input.stderr) ??
      `the profile binary exited with ${exit.signal ?? `code ${exit.code}`}`;
  } else if (!result) {
    error = 'the session produced no result message';
  } else if (result.isError) {
    error = 'the session ended with an error result';
  } else phase = 'succeeded';
  const exitCode = exit?.code;
  const sessionId = streamSessionId(input.stream) ?? input.fallbackSessionId;
  return {
    phase,
    ...(typeof exitCode === 'number' ? { exitCode } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(cut ? { resultText: cut.text } : {}),
    resultTruncated: cut?.truncated ?? false,
    ...(error ? { error: error.slice(0, PLAN_TURN_ERROR_MAX) } : {}),
  };
};
