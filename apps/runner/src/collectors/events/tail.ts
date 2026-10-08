import { closeSync, openSync, readSync, statSync } from 'node:fs';

/** Where `events.jsonl` was read up to: the byte after the last complete line, and the file's identity. */
export interface TailState {
  offset: number;
  inode: number;
}

export interface TailLine {
  text: string;
  /** Byte offset of the line's first byte. */
  offset: number;
}

export interface TailRead {
  lines: TailLine[];
  state: TailState;
  /** More bytes were waiting than one read takes; read again. */
  more: boolean;
}

/** One read takes at most this many bytes; the collector reads again while `more`. */
export const READ_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Reads the complete lines appended to `path` since `previous` (spec 16 D2).
 * A different inode, or a file shorter than the offset, starts over at 0 — the
 * API dedupes what is read twice. A trailing line without its `\n` is left for
 * the next read. `null` when the file does not exist.
 */
export const readNewLines = (
  path: string,
  previous: TailState | undefined,
): TailRead | null => {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const restart =
    !previous || previous.inode !== stat.ino || stat.size < previous.offset;
  const start = restart ? 0 : previous.offset;
  const state: TailState = { offset: start, inode: stat.ino };
  const length = Math.min(stat.size - start, READ_CHUNK_BYTES);
  if (length <= 0) return { lines: [], state, more: false };

  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  let read = 0;
  try {
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, start + read);
      if (n === 0) break;
      read += n;
    }
  } finally {
    closeSync(fd);
  }

  const lines: TailLine[] = [];
  let lineStart = 0;
  for (;;) {
    const newline = buffer.indexOf(0x0a, lineStart);
    if (newline === -1 || newline >= read) break;
    const text = buffer
      .subarray(lineStart, newline)
      .toString('utf8')
      .replace(/\r$/, '');
    if (text.trim().length > 0) {
      lines.push({ text, offset: start + lineStart });
    }
    lineStart = newline + 1;
  }
  state.offset = start + lineStart;
  // A line longer than a whole chunk would never complete: skip past it.
  if (lineStart === 0 && length === READ_CHUNK_BYTES) {
    state.offset = start + length;
  }
  return {
    lines,
    state,
    more: state.offset < stat.size && state.offset > start,
  };
};
