import { z } from 'zod';

/**
 * The lines of a note a person wrote (#449 D7). A person's edit is an
 * instruction: the agent never rewrites those lines, and the runner refuses a
 * note that drops one (`personLinesKept`). Stored as ranges of 1-based line
 * numbers of `content.split('\n')`, inclusive, sorted, apart (two ranges never
 * touch — touching ones are one range). Blank lines are never marked.
 */

/** No note has more person ranges than this. */
export const HANDOFF_PERSON_RANGES_MAX = 500;

/** The suffix that marks a person's line in `.agentdock/handoff.md`. */
export const HANDOFF_PERSON_MARK = ' <!-- person -->';

const lineNumber = z.number().int().min(1).max(100_000);

export const handoffLineRangeSchema = z
  .strictObject({ from: lineNumber, to: lineNumber })
  .refine((r) => r.from <= r.to, {
    message: 'from must not be after to',
    path: ['to'],
  });
export type HandoffLineRange = z.infer<typeof handoffLineRangeSchema>;

export const handoffPersonLinesSchema = z
  .array(handoffLineRangeSchema)
  .max(HANDOFF_PERSON_RANGES_MAX)
  .refine(
    (ranges) =>
      ranges.every((r, i) => i === 0 || r.from > ranges[i - 1].to + 1),
    { message: 'ranges must be sorted and apart' },
  );

const isBlank = (line: string): boolean => line.trim() === '';

const linesOf = (content: string): string[] => content.split('\n');

/** Ranges as sorted, apart ranges — from 1-based line numbers in any order. */
export const rangesOfLines = (lines: Iterable<number>): HandoffLineRange[] => {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges: HandoffLineRange[] = [];
  for (const line of sorted) {
    const last = ranges.at(-1);
    if (last && line === last.to + 1) last.to = line;
    else ranges.push({ from: line, to: line });
  }
  return ranges;
};

/** The 1-based line numbers the ranges cover. */
export const linesOfRanges = (ranges: readonly HandoffLineRange[]): number[] =>
  ranges.flatMap((r) =>
    Array.from({ length: r.to - r.from + 1 }, (_, i) => r.from + i),
  );

/** Whether every range lies within the content's lines. */
export const personLinesFit = (
  content: string,
  ranges: readonly HandoffLineRange[],
): boolean => {
  const count = linesOf(content).length;
  return ranges.every((r) => r.to <= count);
};

/** The non-blank person lines of a note, in order. */
export const personLineTexts = (
  content: string,
  ranges: readonly HandoffLineRange[],
): string[] => {
  const lines = linesOf(content);
  return linesOfRanges(ranges)
    .map((n) => lines[n - 1])
    .filter((line): line is string => line !== undefined && !isBlank(line));
};

/** Above this many cells the edit is not diffed line by line. */
const LCS_MAX_CELLS = 4_000_000;

/**
 * For each line of `next`, the index of the `prev` line it keeps, or -1 —
 * the longest common subsequence after the common prefix and suffix. A middle
 * too large to diff keeps nothing.
 */
const matchLines = (prev: string[], next: string[]): number[] => {
  const match = new Array<number>(next.length).fill(-1);
  let head = 0;
  while (
    head < prev.length &&
    head < next.length &&
    prev[head] === next[head]
  ) {
    match[head] = head;
    head++;
  }
  let tail = 0;
  while (
    tail < prev.length - head &&
    tail < next.length - head &&
    prev[prev.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    match[next.length - 1 - tail] = prev.length - 1 - tail;
    tail++;
  }
  const a = prev.slice(head, prev.length - tail);
  const b = next.slice(head, next.length - tail);
  if (a.length === 0 || b.length === 0 || a.length * b.length > LCS_MAX_CELLS) {
    return match;
  }
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      match[head + j] = head + i;
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return match;
};

/**
 * The person lines after a person's edit (D7, the API's `PUT`): every
 * non-blank line the person added or changed, and every earlier person line
 * the edit kept. A line the agent wrote and the person left alone stays the
 * agent's.
 */
export const markPersonEdit = (
  prevContent: string,
  prevRanges: readonly HandoffLineRange[],
  edited: string,
): HandoffLineRange[] => {
  const prev = linesOf(prevContent);
  const next = linesOf(edited);
  const prevPerson = new Set(linesOfRanges(prevRanges));
  const match = matchLines(prev, next);
  const person: number[] = [];
  next.forEach((line, j) => {
    if (isBlank(line)) return;
    const kept = match[j];
    if (kept === -1 || prevPerson.has(kept + 1)) person.push(j + 1);
  });
  return rangesOfLines(person);
};

export type PersonLinesKept =
  | { ok: true; personLines: HandoffLineRange[] }
  | { ok: false; missing: string[] };

/**
 * Whether the agent's rewrite keeps every person line verbatim and in order
 * (D7), and where they are now. Trailing spaces do not count. The runner
 * refuses a rewrite that drops one and names the lines in its reply.
 */
export const personLinesKept = (
  prevContent: string,
  prevRanges: readonly HandoffLineRange[],
  nextContent: string,
): PersonLinesKept => {
  const wanted = personLineTexts(prevContent, prevRanges);
  const next = linesOf(nextContent);
  const found: number[] = [];
  let at = 0;
  const missing: string[] = [];
  for (const text of wanted) {
    const target = text.trimEnd();
    let hit = -1;
    for (let j = at; j < next.length; j++) {
      if (next[j].trimEnd() === target) {
        hit = j;
        break;
      }
    }
    if (hit === -1) {
      missing.push(text);
    } else {
      found.push(hit + 1);
      at = hit + 1;
    }
  }
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, personLines: rangesOfLines(found) };
};

/** The note as the runner writes it to disk: person lines carry the mark. */
export const markPersonLines = (
  content: string,
  ranges: readonly HandoffLineRange[],
): string => {
  const person = new Set(linesOfRanges(ranges));
  return linesOf(content)
    .map((line, i) =>
      person.has(i + 1) && !isBlank(line)
        ? `${line}${HANDOFF_PERSON_MARK}`
        : line,
    )
    .join('\n');
};

/** The inverse of `markPersonLines`: the content without marks, and its ranges. */
export const splitPersonMarks = (
  marked: string,
): { content: string; personLines: HandoffLineRange[] } => {
  const person: number[] = [];
  const lines = linesOf(marked).map((line, i) => {
    const bare = line.trimEnd();
    if (!bare.endsWith(HANDOFF_PERSON_MARK.trimStart())) return line;
    const text = bare
      .slice(0, -HANDOFF_PERSON_MARK.trimStart().length)
      .trimEnd();
    if (!isBlank(text)) person.push(i + 1);
    return text;
  });
  return { content: lines.join('\n'), personLines: rangesOfLines(person) };
};
