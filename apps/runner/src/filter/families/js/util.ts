import { isProtectedLine, stripAnsi } from '../../classify';

/**
 * The output of one command, compressed, or `null` when it is not an output
 * this compressor recognises (D4b: a filter that cannot classify the output
 * returns it unchanged).
 */
export type Compress = (output: string) => string | null;

export const splitLines = (output: string): string[] => {
  const lines = output.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

export const plainLines = (lines: readonly string[]): string[] =>
  lines.map(stripAnsi);

export const isBlank = (plain: string): boolean => plain.trim().length === 0;

export const indentOf = (plain: string): number =>
  plain.length - plain.trimStart().length;

/**
 * The lines that stay: everything not marked dropped, plus every line the
 * classifier protects, whatever was decided about it. A filter therefore
 * can never lose an error, failure, warning or stack line by mistake.
 */
export const survivors = (
  lines: readonly string[],
  dropped: readonly boolean[],
): string[] => lines.filter((line, i) => !dropped[i] || isProtectedLine(line));

/** Whether line `i` is gone in the result: blank, or dropped and unprotected. */
export const isGone = (
  lines: readonly string[],
  dropped: readonly boolean[],
  i: number,
): boolean => {
  const line = lines[i] ?? '';
  if (isBlank(stripAnsi(line))) return true;
  return dropped[i] === true && !isProtectedLine(line);
};

/**
 * Marks a header line dropped when everything up to the next `isEnd` line is
 * gone: a file or suite title whose only content was passing tests.
 */
export const dropEmptyHeaders = (
  lines: readonly string[],
  dropped: boolean[],
  isHeader: (plain: string) => boolean,
  isEnd: (plain: string) => boolean,
): void => {
  const plain = plainLines(lines);
  for (let i = 0; i < lines.length; i++) {
    if (dropped[i] || !isHeader(plain[i] ?? '')) continue;
    let j = i + 1;
    while (j < lines.length && !isEnd(plain[j] ?? '')) j++;
    let empty = true;
    for (let k = i + 1; k < j && empty; k++) empty = isGone(lines, dropped, k);
    if (empty) dropped[i] = true;
  }
};

/** Collapses runs of blank lines and trims blank lines at both ends. */
export const squeezeBlank = (lines: readonly string[]): string[] => {
  const out: string[] = [];
  for (const line of lines) {
    const blank = isBlank(stripAnsi(line));
    if (blank && (out.length === 0 || isBlank(stripAnsi(out.at(-1) ?? '')))) {
      continue;
    }
    out.push(line);
  }
  while (out.length > 0 && isBlank(stripAnsi(out.at(-1) ?? ''))) out.pop();
  return out;
};

/**
 * The compressed text of `kept`, or `null` when it does not differ from the
 * original output (the engine would return the original anyway).
 */
export const finish = (
  original: string,
  kept: readonly string[],
): string | null => {
  const lines = squeezeBlank(kept);
  const text = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  return text === original ? null : text;
};

/** The usual form: drop the lines `drop` accepts, keep the protected ones. */
export const dropMatching = (
  output: string,
  drop: (plain: string, index: number, plains: readonly string[]) => boolean,
): string | null => {
  const lines = splitLines(output);
  const plains = plainLines(lines);
  const dropped = plains.map((p, i) => drop(p, i, plains));
  return finish(output, survivors(lines, dropped));
};
