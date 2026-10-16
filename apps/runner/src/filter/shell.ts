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
 *
 * Amendment 11 adds two forms around that one command, and only these two:
 * a leading `cd <literal path> &&`, and a trailing `2>&1` (`parseHookCommand`).
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

/** An unquoted `&&`, the one operator the scanner hands back (amendment 11). */
const AND = Symbol('&&');

type Token = Word | typeof AND;

/** `&&` here: not `&`, and not the start of `&&&` (a syntax error in bash). */
const isAnd = (input: string, i: number): boolean =>
  input[i] === '&' && input[i + 1] === '&' && input[i + 2] !== '&';

/**
 * Splits into words and unquoted `&&`s, or returns null at the first sign of
 * anything else.
 */
const tokens = (input: string): Token[] | null => {
  if (!PRINTABLE.test(input) || NEVER.test(input)) return null;
  const out: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i] ?? '';
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (isAnd(input, i)) {
      out.push(AND);
      i += 2;
      continue;
    }
    const start = i;
    let text = '';
    while (i < input.length) {
      const ch = input[i] ?? '';
      if (ch === ' ' || ch === '\t' || isAnd(input, i)) break;
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

const isWord = (token: Token | undefined): token is Word =>
  token !== undefined && token !== AND;

const simple = (all: readonly Word[]): SimpleCommand | null => {
  if (all.length === 0) return null;
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

/** Words only: a `&&` anywhere makes it not one simple command. */
const fromWords = (all: readonly Token[]): SimpleCommand | null => {
  const words = all.filter(isWord);
  return words.length === all.length ? simple(words) : null;
};

/** The command as one simple command, or `null` if it is anything else. */
export const parseSimpleCommand = (input: string): SimpleCommand | null => {
  const all = tokens(input);
  return all ? fromWords(all) : null;
};

/**
 * A command the hook may rewrite (#445 amendments 3 and 11): one simple
 * command, optionally after `cd <literal path> &&` and optionally followed by
 * `2>&1`.
 */
export interface HookCommand {
  /** The `cd` target with quotes removed, or null without a leading `cd`. */
  cd: string | null;
  command: SimpleCommand;
  /** A trailing `2>&1` was written; the rewrite keeps it. */
  mergeStderr: boolean;
}

/**
 * A trailing `2>&1` after an unquoted blank. Whether that blank really is
 * outside quotes and unescaped is settled by parsing what comes before it:
 * an open quote or a trailing `\` there makes the whole command not simple.
 */
const TRAILING_MERGE = /[ \t]2>&1[ \t]*$/;

/** The command in one of the forms the hook rewrites, or `null`. */
export const parseHookCommand = (input: string): HookCommand | null => {
  const merge = TRAILING_MERGE.exec(input);
  const body = merge ? input.slice(0, merge.index) : input;
  const all = tokens(body);
  if (!all) return null;
  const mergeStderr = merge !== null;
  if (!all.includes(AND)) {
    const command = fromWords(all);
    return command ? { cd: null, command, mergeStderr } : null;
  }
  // `cd <one literal word> && <simple command>`, nothing else.
  const [head, target, and, ...rest] = all;
  if (!isWord(head) || head.raw !== 'cd') return null;
  if (!isWord(target) || and !== AND) return null;
  // No `cd -`, `cd -P`, `cd --`, and no empty target.
  if (target.text === '' || target.text.startsWith('-')) return null;
  const command = fromWords(rest);
  return command ? { cd: target.text, command, mergeStderr } : null;
};

/** Single-quotes a word for a POSIX shell. */
export const shellQuote = (word: string): string =>
  /^[A-Za-z0-9_./=:@%+-]+$/.test(word)
    ? word
    : `'${word.replace(/'/g, `'\\''`)}'`;

/** `NAME=value` re-quoted: the name bare, so it stays an assignment. */
export const quoteAssignment = (assignment: Assignment): string =>
  `${assignment.name}=${assignment.value === '' ? '' : shellQuote(assignment.value)}`;
