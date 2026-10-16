/**
 * Just enough shell to tell a single simple command from everything else
 * (#445 amendment 3). The hook rewrites only `[VAR=value …] program args…`;
 * a pipe, a list, a redirect, a heredoc, a subshell, a substitution or a
 * compound keyword makes it leave the command alone. When in doubt, it is
 * not simple.
 */

export interface SimpleCommand {
  /** Leading `NAME=value` words, exactly as written. */
  assignments: string;
  /** The command after the assignments, exactly as written. */
  command: string;
  /** Its words with quotes removed (variables left unexpanded). */
  argv: string[];
}

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
  '{',
  '}',
  'exec',
  'eval',
  'source',
  '.',
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Characters that end or chain a simple command outside quotes. */
const OPERATORS = new Set(['|', '&', ';', '<', '>', '(', ')', '`', '\n', '\r']);

interface Word {
  text: string;
  start: number;
  end: number;
}

/** Splits into words, or returns null at the first sign of a non-simple command. */
const words = (input: string): Word[] | null => {
  const out: Word[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i] ?? '';
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '#') break; // a comment runs to the end; newlines are refused above
    const start = i;
    let text = '';
    while (i < input.length) {
      const ch = input[i] ?? '';
      if (ch === ' ' || ch === '\t') break;
      if (OPERATORS.has(ch)) return null;
      if (ch === '\\') {
        const next = input[i + 1];
        if (next === undefined || next === '\n') return null;
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
        for (; j < input.length; j++) {
          const q = input[j];
          if (q === '\\') {
            j++;
            continue;
          }
          if (q === '`') return null;
          if (q === '$' && input[j + 1] === '(') return null;
          if (q === '"') break;
        }
        if (j >= input.length) return null;
        text += input.slice(i + 1, j).replace(/\\(["\\$`])/g, '$1');
        i = j + 1;
        continue;
      }
      if (ch === '$' && input[i + 1] === '(') return null;
      text += ch;
      i++;
    }
    out.push({ text, start, end: i });
  }
  return out;
};

/** The command as one simple command, or `null` if it is anything else. */
export const parseSimpleCommand = (input: string): SimpleCommand | null => {
  const all = words(input);
  if (!all || all.length === 0) return null;
  let first = 0;
  while (first < all.length && ASSIGNMENT.test(all[first]?.text ?? '')) {
    first++;
  }
  const head = all[first];
  if (!head || KEYWORDS.has(head.text)) return null;
  const rest = all.slice(first);
  const last = rest[rest.length - 1] ?? head;
  return {
    assignments: first > 0 ? input.slice(0, head.start).trim() : '',
    command: input.slice(head.start, last.end),
    argv: rest.map((w) => w.text),
  };
};

/** Single-quotes a word for a POSIX shell. */
export const shellQuote = (word: string): string =>
  /^[A-Za-z0-9_./=:@%+-]+$/.test(word)
    ? word
    : `'${word.replace(/'/g, `'\\''`)}'`;
