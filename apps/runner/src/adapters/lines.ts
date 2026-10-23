import { open } from 'node:fs/promises';

const READ_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

/**
 * The longest line kept. A transcript line carries a whole message — an
 * image, a long tool result — so the cap is generous; a longer line is an
 * agent's runaway output and would hold its full length in memory.
 */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

/** Complete lines read in one batch, and the byte after the last of them. */
export interface LineBatch {
  lines: string[];
  nextOffset: number;
}

export interface ReadLinesOptions {
  batchLines?: number;
  maxLineBytes?: number;
  /** Called for each line longer than `maxLineBytes`; the line is dropped. */
  onDropped?: (drop: { offset: number; bytes: number }) => void;
}

/**
 * Reads complete lines from byte `offset` to the end of the file, in batches
 * of at most `batchLines`. A last line without its newline is still being
 * written: it is left for the next read, and `nextOffset` stops before it.
 * A line longer than `maxLineBytes` is never held: its bytes are counted,
 * not kept, and it is dropped (`onDropped`) once its newline is read.
 */
export async function* readLines(
  path: string,
  offset: number,
  options: ReadLinesOptions = {},
): AsyncGenerator<LineBatch> {
  const batchLines = options.batchLines ?? 500;
  const maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(READ_BYTES);
    let position = offset;
    let consumed = offset;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    // The partial line passed `maxLineBytes`: `pendingBytes` counts it, `pending` is empty.
    let dropping = false;
    let lines: string[] = [];
    let yielded = offset;
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, READ_BYTES, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      let start = 0;
      for (;;) {
        const end = buffer.indexOf(NEWLINE, start);
        if (end === -1 || end >= bytesRead) break;
        const length = pendingBytes + end - start;
        if (dropping || length > maxLineBytes) {
          options.onDropped?.({ offset: consumed, bytes: length });
        } else {
          pending.push(buffer.subarray(start, end));
          lines.push(Buffer.concat(pending).toString('utf8'));
        }
        pending = [];
        pendingBytes = 0;
        dropping = false;
        consumed += length + 1;
        start = end + 1;
        if (lines.length >= batchLines) {
          yield { lines, nextOffset: consumed };
          yielded = consumed;
          lines = [];
        }
      }
      if (start < bytesRead) {
        pendingBytes += bytesRead - start;
        if (dropping || pendingBytes > maxLineBytes) {
          dropping = true;
          pending = [];
        } else {
          // `buffer` is reused by the next read: keep a copy of the partial line.
          pending.push(Buffer.from(buffer.subarray(start, bytesRead)));
        }
      }
    }
    // A dropped line alone still moves the offset past it.
    if (consumed > yielded) yield { lines, nextOffset: consumed };
  } finally {
    await file.close();
  }
}
