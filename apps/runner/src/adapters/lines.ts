import { open } from 'node:fs/promises';

const READ_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

/** Complete lines read in one batch, and the byte after the last of them. */
export interface LineBatch {
  lines: string[];
  nextOffset: number;
}

/**
 * Reads complete lines from byte `offset` to the end of the file, in batches
 * of at most `batchLines`. A last line without its newline is still being
 * written: it is left for the next read, and `nextOffset` stops before it.
 */
export async function* readLines(
  path: string,
  offset: number,
  batchLines = 500,
): AsyncGenerator<LineBatch> {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(READ_BYTES);
    let position = offset;
    let consumed = offset;
    let pending: Buffer[] = [];
    let lines: string[] = [];
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, READ_BYTES, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      let start = 0;
      for (;;) {
        const end = buffer.indexOf(NEWLINE, start);
        if (end === -1 || end >= bytesRead) break;
        pending.push(buffer.subarray(start, end));
        const line = Buffer.concat(pending);
        pending = [];
        consumed += line.length + 1;
        lines.push(line.toString('utf8'));
        start = end + 1;
        if (lines.length >= batchLines) {
          yield { lines, nextOffset: consumed };
          lines = [];
        }
      }
      // `buffer` is reused by the next read: keep a copy of the partial line.
      if (start < bytesRead) {
        pending.push(Buffer.from(buffer.subarray(start, bytesRead)));
      }
    }
    if (lines.length > 0) yield { lines, nextOffset: consumed };
  } finally {
    await file.close();
  }
}
