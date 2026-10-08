/** Serialized size of one line inside a JSON array: quotes, escapes, comma. */
const lineBytes = (line: string): number =>
  Buffer.byteLength(JSON.stringify(line)) + 1;

/** Room kept for the frame's own fields and the message envelope. */
const ENVELOPE_BYTES = 512;

/** Drops lines from the top until the frame fits `maxBytes` (spec 18 D4). */
export const capLines = (
  lines: readonly string[],
  maxBytes: number,
): string[] => {
  let total = ENVELOPE_BYTES;
  let keep = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lineBytes(lines[i] ?? '');
    if (total > maxBytes) break;
    keep++;
  }
  return lines.slice(lines.length - keep);
};

/**
 * The patch that turns `previous` into `next`: from the first differing line
 * to the end. Null when they are equal.
 */
export const diffLines = (
  previous: readonly string[],
  next: readonly string[],
): { from: number; lines: string[] } | null => {
  const shared = Math.min(previous.length, next.length);
  let from = 0;
  while (from < shared && previous[from] === next[from]) from++;
  if (from === previous.length && from === next.length) return null;
  return { from, lines: next.slice(from) };
};

/** `tmux capture-pane -p` output as lines: the final newline ends a line, not starts one. */
export const splitCapture = (stdout: string): string[] => {
  const lines = stdout.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};
