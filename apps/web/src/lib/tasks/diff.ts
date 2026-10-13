export type DiffKind = 'same' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/** Past this many lines on either side the table is not built; the diff is whole-text. */
const MAX_LINES = 2000;

const linesOf = (text: string): string[] =>
  text === '' ? [] : text.replace(/\r\n/g, '\n').split('\n');

/**
 * A line diff of `before` against `after` by longest common subsequence:
 * enough to read what an instructions edit changed, without a dependency.
 * Two texts too long for the table come back as all removed, then all added.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = linesOf(before);
  const b = linesOf(after);

  // Trim the shared head and tail: most edits touch a few lines of many.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const out: DiffLine[] = a
    .slice(0, head)
    .map((text) => ({ kind: 'same', text }));

  if (midA.length > MAX_LINES || midB.length > MAX_LINES) {
    for (const text of midA) out.push({ kind: 'removed', text });
    for (const text of midB) out.push({ kind: 'added', text });
  } else {
    // lcs[i][j]: the common length of midA[i..] and midB[j..].
    const lcs = Array.from({ length: midA.length + 1 }, () =>
      new Array<number>(midB.length + 1).fill(0),
    );
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        lcs[i][j] =
          midA[i] === midB[j]
            ? lcs[i + 1][j + 1] + 1
            : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        out.push({ kind: 'same', text: midA[i] });
        i++;
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        out.push({ kind: 'removed', text: midA[i++] });
      } else {
        out.push({ kind: 'added', text: midB[j++] });
      }
    }
    while (i < midA.length) out.push({ kind: 'removed', text: midA[i++] });
    while (j < midB.length) out.push({ kind: 'added', text: midB[j++] });
  }

  for (const text of a.slice(a.length - tail)) out.push({ kind: 'same', text });
  return out;
}

export const diffStat = (
  lines: readonly DiffLine[],
): { added: number; removed: number } => ({
  added: lines.filter((line) => line.kind === 'added').length,
  removed: lines.filter((line) => line.kind === 'removed').length,
});
