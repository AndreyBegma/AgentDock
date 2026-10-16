import { isProtectedLine, stripAnsi } from '../../classify';

/**
 * Helpers shared by the ops filters. Every one of them keeps what the
 * classifier protects: the engine would overrule a filter that did not, so
 * the helpers do it up front and the filters stay simple.
 */

/**
 * The output as lines, as a person would read it: no escapes, and a
 * carriage-return progress meter reduced to its last state. A segment the
 * classifier protects is never lost to the redraw.
 */
export const cleanLines = (output: string): string[] => {
  const lines: string[] = [];
  for (const raw of stripAnsi(output).split('\n')) {
    if (!raw.includes('\r')) {
      lines.push(raw);
      continue;
    }
    const segments = raw.split('\r').filter((s) => s.trim().length > 0);
    const last = segments[segments.length - 1];
    for (const segment of segments) {
      if (segment === last || isProtectedLine(segment)) lines.push(segment);
    }
  }
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '')
    lines.pop();
  return lines;
};

/** Joins lines back into an output that ends with a newline. */
export const joinLines = (lines: readonly string[]): string =>
  lines.length === 0 ? '' : `${lines.join('\n')}\n`;

/** Collapses runs of identical lines into the line and `  [×N]`. */
export const collapseRepeats = (lines: readonly string[]): string[] => {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    let j = i + 1;
    while (j < lines.length && lines[j] === line && line.trim() !== '') j++;
    out.push(j - i > 2 ? `${line}  [×${j - i}]` : line);
    if (j - i === 2) out.push(line);
    i = j;
  }
  return out;
};

/** Drops blank lines that follow another blank line, and leading ones. */
export const squeezeBlanks = (lines: readonly string[]): string[] =>
  lines.filter(
    (line, i) => line.trim() !== '' || (i > 0 && lines[i - 1]?.trim() !== ''),
  );

export interface ElideOptions {
  head: number;
  tail: number;
  /** Lines to keep wherever they are, besides the protected ones. */
  keep?: (line: string) => boolean;
}

/**
 * Keeps the first `head` and last `tail` lines and every line that matters,
 * and replaces each run of other lines with a marker. A run of one or two
 * lines is kept: a marker would not be shorter.
 */
export const elide = (
  lines: readonly string[],
  { head, tail, keep }: ElideOptions,
): string[] => {
  if (lines.length <= head + tail + 2) return [...lines];
  const kept = lines.map(
    (line, i) =>
      i < head ||
      i >= lines.length - tail ||
      isProtectedLine(line) ||
      (keep?.(line) ?? false),
  );
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (kept[i]) {
      out.push(lines[i] ?? '');
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && !kept[j]) j++;
    if (j - i <= 2) out.push(...lines.slice(i, j));
    else out.push(`… ${j - i} lines omitted …`);
    i = j;
  }
  return out;
};

/**
 * The first non-flag word after the program, skipping the flags in
 * `withValue` together with their value (`git -C dir status`).
 */
export const subcommand = (
  argv: readonly string[],
  withValue: readonly string[] = [],
): string | undefined => {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (withValue.includes(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return undefined;
};

/** The non-flag words after the program, skipping the flags in `withValue`. */
export const positionals = (
  argv: readonly string[],
  withValue: readonly string[] = [],
): string[] => {
  const words: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (withValue.includes(arg)) {
      i++;
      continue;
    }
    if (!arg.startsWith('-')) words.push(arg);
  }
  return words;
};

/** Whether any of `flags` is among the arguments, also as `--flag=value`. */
export const hasFlag = (argv: readonly string[], ...flags: string[]): boolean =>
  argv.some((arg) =>
    flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
  );

/** Whether the text is a JSON document an agent will parse: leave it alone. */
export const looksLikeJson = (output: string): boolean => {
  const first = output.trimStart()[0];
  return first === '{' || first === '[';
};
