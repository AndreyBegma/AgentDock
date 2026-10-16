/**
 * Just enough shell to tell a single simple command from everything else
 * (#445 amendment 3). The hook rewrites only `[NAME=value …] program args…`;
 * a pipe, a list, a redirect, a heredoc, a subshell, a substitution, a
 * comment, an expansion or a compound keyword makes it leave the command
 * alone.
 *
 * It is a whitelist, not a shell: whatever it does not understand exactly is
 * not simple. The hook then builds the rewrite from `argv`, re-quoted, never
 * from the original text — so what bash runs is what this parser saw, and a
 * quoting rule bash has and this parser lacks (`$'…'`, say) can never smuggle
 * a second command through.
 */

export interface Assignment {
  name: string;
  /** The value with quotes removed. */
  value: string;
}

export interface SimpleCommand {
  /** Leading `NAME=value` words, unquoted. */
  assignments: Assignment[];
  /** The command's words with quotes removed. */
  argv: string[];
}

/** Words that make the rest of the line something other than one command. */
const KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'select',
  'function',
  'time',
  'coproc',
  '!',
  '[[',
  ']]',
  '{',
  '}',
  'exec',
  'eval',
  'source',
  '.',
  'command',
  'builtin',
  'env',
  'sudo',
  'nohup',
  'xargs',
]);

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;

/** Only printable ASCII and tabs: no newline, no control, no lookalike. */
const PRINTABLE = /^[\t\x20-\x7e]*$/;

/**
 * Refused anywhere, quoted or not: every expansion (`$`, including `$'…'`
 * and `$"…"`), command substitution, comments, history expansion.
 */
const NEVER = /[$`#!]/;

/** Characters that end or chain a simple command outside quotes. */
const OPERATORS = new Set(['|', '&', ';', '<', '>', '(', ')']);

/** Unquoted, these expand (globs, braces, tilde); quoted, they are literal. */
const EXPANDS = new Set(['*', '?', '[', ']', '{', '}', '~']);

interface Word {
  /** As written. */
  raw: string;
  /** With quotes removed. */
  text: string;
}

/** Splits into words, or returns null at the first sign of a non-simple command. */
const words = (input: string): Word[] | null => {
  if (!PRINTABLE.test(input) || NEVER.test(input)) return null;
  const out: Word[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i] ?? '';
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    const start = i;
    let text = '';
    while (i < input.length) {
      const ch = input[i] ?? '';
      if (ch === ' ' || ch === '\t') break;
      if (OPERATORS.has(ch) || EXPANDS.has(ch)) return null;
      if (ch === '\\') {
        const next = input[i + 1];
        if (next === undefined) return null;
        text += next;
        i += 2;
        continue;
      }
      if (ch === "'") {
        const close = input.indexOf("'", i + 1);
        if (close < 0) return null;
        text += input.slice(i + 1, close);
        i = close + 1;
        continue;
      }
      if (ch === '"') {
        let j = i + 1;
        let inner = '';
        for (; j < input.length; j++) {
          const q = input[j] ?? '';
          if (q === '"') break;
          if (q === '\\') {
            const next = input[j + 1];
            if (next === undefined) return null;
            // Inside double quotes a backslash escapes only `"` and `\`
            // here (`$`, backquote and newline are refused above).
            if (next === '"' || next === '\\') {
              inner += next;
              j++;
              continue;
            }
          }
          inner += q;
        }
        if (j >= input.length) return null;
        text += inner;
        i = j + 1;
        continue;
      }
      text += ch;
      i++;
    }
    out.push({ raw: input.slice(start, i), text });
  }
  return out;
};

/** The command as one simple command, or `null` if it is anything else. */
export const parseSimpleCommand = (input: string): SimpleCommand | null => {
  const all = words(input);
  if (!all || all.length === 0) return null;
  const assignments: Assignment[] = [];
  let first = 0;
  for (; first < all.length; first++) {
    const word = all[first];
    // Only an unquoted name makes an assignment: `'A=1' cmd` runs `A=1`.
    const name = word ? ASSIGNMENT.exec(word.raw)?.[1] : undefined;
    if (!word || name === undefined) break;
    assignments.push({ name, value: word.text.slice(name.length + 1) });
  }
  const head = all[first];
  if (!head || head.raw !== head.text || KEYWORDS.has(head.text)) return null;
  return { assignments, argv: all.slice(first).map((w) => w.text) };
};

/** Single-quotes a word for a POSIX shell. */
export const shellQuote = (word: string): string =>
  /^[A-Za-z0-9_./=:@%+-]+$/.test(word)
    ? word
    : `'${word.replace(/'/g, `'\\''`)}'`;

/** `NAME=value` re-quoted: the name bare, so it stays an assignment. */
export const quoteAssignment = (assignment: Assignment): string =>
  `${assignment.name}=${assignment.value === '' ? '' : shellQuote(assignment.value)}`;
