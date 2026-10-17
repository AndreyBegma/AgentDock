import {
  historyLineBytes,
  TERMINAL_HISTORY_CHUNK_BYTES,
  TERMINAL_HISTORY_LINE_MAX_CHARS,
  TERMINAL_HISTORY_LINES,
  TERMINAL_HISTORY_MAX_BYTES,
} from '@agentdock/shared/protocol';
import { splitCapture } from '../pane/frame';

/**
 * `capture-pane` of an attach's session (#522), like the pane streamer's: the
 * current pane with its ANSI sequences (`-e`), wrapped lines joined (`-J`),
 * from `TERMINAL_HISTORY_LINES` back. The `=` makes the target exact, as in
 * `attachArgv`. It reads the pane only: no copy-mode, no input.
 */
export const historyArgv = (
  tmuxServer: readonly string[],
  session: string,
): string[] => [
  ...tmuxServer,
  'capture-pane',
  '-p',
  '-e',
  '-J',
  '-t',
  `=${session}:`,
  '-S',
  `-${TERMINAL_HISTORY_LINES}`,
];

/**
 * The capture as `terminal.history` chunks, oldest line first: the last
 * `TERMINAL_HISTORY_LINES` lines, each cut to `TERMINAL_HISTORY_LINE_MAX_CHARS`,
 * the oldest dropped past `TERMINAL_HISTORY_MAX_BYTES`, split into chunks of
 * at most `TERMINAL_HISTORY_CHUNK_BYTES`. Always at least one chunk.
 */
export const historyChunks = (stdout: string): string[][] => {
  const lines = splitCapture(stdout)
    .slice(-TERMINAL_HISTORY_LINES)
    .map((line) => line.slice(0, TERMINAL_HISTORY_LINE_MAX_CHARS));
  let total = 0;
  let from = lines.length;
  while (from > 0) {
    const size = historyLineBytes(lines[from - 1] ?? '');
    if (total + size > TERMINAL_HISTORY_MAX_BYTES) break;
    total += size;
    from--;
  }
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let size = 0;
  for (const line of lines.slice(from)) {
    const bytes = historyLineBytes(line);
    if (chunk.length > 0 && size + bytes > TERMINAL_HISTORY_CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = [];
      size = 0;
    }
    chunk.push(line);
    size += bytes;
  }
  chunks.push(chunk);
  return chunks;
};
