import { isProtectedLine, stripAnsi } from '../../classify';

/**
 * Helpers shared by the lang filters. They keep what the classifier protects,
 * so a filter built from them is not overruled by the engine for the lines it
 * was never going to drop.
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

/** Drops the lines `noise` matches, except the ones the classifier protects. */
export const dropNoise = (lines: readonly string[], noise: RegExp): string[] =>
  lines.filter((line) => !noise.test(line) || isProtectedLine(line));

/** Drops blank lines that follow another blank line, and leading ones. */
export const squeezeBlanks = (lines: readonly string[]): string[] =>
  lines.filter(
    (line, i) => line.trim() !== '' || (i > 0 && lines[i - 1]?.trim() !== ''),
  );

/** Drops a line when an earlier line is identical, blank lines excepted. */
export const dedupe = (lines: readonly string[]): string[] => {
  const seen = new Set<string>();
  return lines.filter((line) => {
    if (line.trim() === '') return true;
    if (seen.has(line)) return false;
    seen.add(line);
    return true;
  });
};

/**
 * Replaces each run of lines that are not `kept` with a marker. A run of one
 * or two lines stays: a marker would not be shorter.
 */
export const elideRuns = (
  lines: readonly string[],
  kept: readonly boolean[],
): string[] => {
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

export interface ElideOptions {
  head: number;
  tail: number;
}

/**
 * Keeps the first `head` and last `tail` lines and every protected line;
 * everything between is replaced by markers.
 */
export const elide = (
  lines: readonly string[],
  { head, tail }: ElideOptions,
): string[] => {
  if (lines.length <= head + tail + 2) return [...lines];
  return elideRuns(
    lines,
    lines.map(
      (line, i) =>
        i < head || i >= lines.length - tail || isProtectedLine(line),
    ),
  );
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

const PYTHON = /^python(\d+(\.\d+)*)?$/;
const RUNNERS = new Set(['uv', 'poetry', 'pipenv', 'pdm', 'rye']);

/**
 * The command a launcher runs: `python -m pytest` and `uv run pytest` are
 * `pytest`, `bundle exec rspec` is `rspec`. Anything else comes back as is.
 */
export const effective = (argv: readonly string[]): string[] => {
  let words = [...argv];
  for (let depth = 0; depth < 3 && words.length > 0; depth++) {
    const [program, next] = words;
    if (program && PYTHON.test(program) && next === '-m' && words[2]) {
      words = words.slice(2);
    } else if (program && RUNNERS.has(program) && next === 'run' && words[2]) {
      words = words.slice(2);
    } else if (
      (program === 'bundle' || program === 'bundler') &&
      next === 'exec' &&
      words[2]
    ) {
      words = words.slice(2);
    } else {
      break;
    }
  }
  return words;
};
