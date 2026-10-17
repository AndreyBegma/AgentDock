/**
 * Just enough shell to tell a simple command from everything else (#445
 * amendment 3). The hook rewrites only `[NAME=value …] program args…`; a
 * redirect, a heredoc, a subshell, a substitution, a comment, an expansion,
 * a background `&` or a compound keyword makes it leave the line alone.
 *
 * It is a whitelist, not a shell: whatever it does not understand exactly is
 * not simple. The hook then builds the rewrite from `argv`, re-quoted, never
 * from the original text — so what bash runs is what this parser saw, and a
 * quoting rule bash has and this parser lacks (`$'…'`, say) can never smuggle
 * a second command through.
 *
 * Around those simple commands it knows only `|`, `&&`, `||`, `;` and a
 * `2>&1` right after a command's words (amendment 11, #610:
 * `parseHookCommand`).
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

/**
 * The unquoted operators the scanner hands back: `&&` (amendment 11), and
 * `||`, `;`, `|` and a `2>&1` (#610). Anything else that is not a word makes
 * the whole line not rewritable.
 */
export type ListOperator = '&&' | '||' | ';';
type Operator = ListOperator | '|' | '2>&1';

type Token = Word | { op: Operator };

/** `&&` here: not `&`, and not the start of `&&&` (a syntax error in bash). */
const isAnd = (input: string, i: number): boolean =>
  input[i] === '&' && input[i + 1] === '&' && input[i + 2] !== '&';

/** Where a `2>&1` ends a word: a blank, the end, or an operator. */
const ENDS_MERGE = new Set([undefined, ' ', '\t', '|', ';', '&']);

/**
 * The operator at `i`, if one starts there. `|&`, `|||`, `;;` and `;&` are
 * not ones this parser knows, so they are refused (`null`); a lone `&` falls
 * through to the word scanner, which refuses it too.
 */
const operatorAt = (input: string, i: number): Operator | null | undefined => {
  const c = input[i];
  const next = input[i + 1];
  if (isAnd(input, i)) return '&&';
  if (c === '|') {
    if (next === '|') return input[i + 2] === '|' ? null : '||';
    return next === '&' ? null : '|';
  }
  if (c === ';') return next === ';' || next === '&' ? null : ';';
  if (input.startsWith('2>&1', i) && ENDS_MERGE.has(input[i + 4])) {
    return '2>&1';
  }
  return undefined;
};

/**
 * Splits into words and the operators above, or returns null at the first
 * sign of anything else.
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
    const op = operatorAt(input, i);
    if (op === null) return null;
    if (op !== undefined) {
      out.push({ op });
      i += op.length;
      continue;
    }
    const start = i;
    let text = '';
    while (i < input.length) {
      const ch = input[i] ?? '';
      if (ch === ' ' || ch === '\t' || ch === '|' || ch === ';') break;
      if (isAnd(input, i)) break;
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
  token !== undefined && !('op' in token);

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

/** Words only: an operator anywhere makes it not one simple command. */
const fromWords = (all: readonly Token[]): SimpleCommand | null => {
  const words = all.filter(isWord);
  return words.length === all.length ? simple(words) : null;
};

/** The command as one simple command, or `null` if it is anything else. */
export const parseSimpleCommand = (input: string): SimpleCommand | null => {
  const all = tokens(input);
  return all ? fromWords(all) : null;
};

/** One simple command of a pipeline, and whether it ends in `2>&1`. */
export interface Stage {
  command: SimpleCommand;
  /** A `2>&1` was written after its words; the rewrite keeps it. */
  mergeStderr: boolean;
}

/**
 * A line the hook may rewrite (#445 amendments 3 and 11, #610): simple
 * commands joined by `|` into pipelines, and pipelines joined by `&&`, `||`
 * and `;` into a list. Each command may end in `2>&1`. A single simple
 * command is a list of one pipeline of one stage.
 */
export interface HookCommand {
  /** In order; each has at least one stage. */
  pipelines: Stage[][];
  /** `operators[i]` joins `pipelines[i]` and `pipelines[i + 1]`. */
  operators: ListOperator[];
}

const isListOperator = (op: Operator): op is ListOperator =>
  op === '&&' || op === '||' || op === ';';

/**
 * The line as a list of pipelines, or `null`. Every stage must be a simple
 * command: no empty stage (so no leading, trailing or doubled operator), and
 * a `2>&1` only right after a stage's words.
 */
export const parseHookCommand = (input: string): HookCommand | null => {
  const all = tokens(input);
  if (!all || all.length === 0) return null;
  const pipelines: Stage[][] = [[]];
  const operators: ListOperator[] = [];
  let words: Word[] = [];
  let merge = false;
  const endStage = (): boolean => {
    const command = simple(words);
    if (!command) return false;
    pipelines[pipelines.length - 1]?.push({ command, mergeStderr: merge });
    words = [];
    merge = false;
    return true;
  };
  for (const token of all) {
    if (isWord(token)) {
      // Nothing may follow a `2>&1` in its stage.
      if (merge) return null;
      words.push(token);
      continue;
    }
    if (token.op === '2>&1') {
      if (merge || words.length === 0) return null;
      merge = true;
      continue;
    }
    if (!endStage()) return null;
    if (isListOperator(token.op)) {
      operators.push(token.op);
      pipelines.push([]);
    }
  }
  return endStage() ? { pipelines, operators } : null;
};

/** Single-quotes a word for a POSIX shell. */
export const shellQuote = (word: string): string =>
  /^[A-Za-z0-9_./=:@%+-]+$/.test(word)
    ? word
    : `'${word.replace(/'/g, `'\\''`)}'`;

/** `NAME=value` re-quoted: the name bare, so it stays an assignment. */
export const quoteAssignment = (assignment: Assignment): string =>
  `${assignment.name}=${assignment.value === '' ? '' : shellQuote(assignment.value)}`;
