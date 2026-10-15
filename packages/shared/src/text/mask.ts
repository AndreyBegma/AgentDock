/**
 * D6 (issue #271): code is never sent for translation. Before the call,
 * `maskText` replaces every code-like span with a numbered placeholder
 * `⟦1⟧`, `⟦2⟧`, … in order of appearance; the model must return each one
 * exactly once and invent none (`checkPlaceholders`); `unmaskText` puts the
 * spans back byte for byte.
 *
 * Masked, in this order of precedence where two overlap:
 * - fenced blocks (```` ``` ```` and `~~~`, to the closing fence or the end);
 * - inline code;
 * - anything already shaped like a placeholder, so it survives the trip;
 * - URLs and e-mail addresses;
 * - file paths: an ASCII token containing `/` or `\`, or a dotfile;
 * - `#123`, `C-12`, `@mentions`;
 * - identifiers: camelCase, PascalCase with an inner capital, snake_case,
 *   SCREAMING_CASE and dotted `a.b.c` (which also covers `name.ext`).
 *
 * Paths and identifiers are ASCII only, so "да/нет" is still translated.
 */

export const TEXT_PLACEHOLDER_PATTERN = /⟦(\d+)⟧/g;

export const textPlaceholder = (n: number): string => `⟦${n}⟧`;

export interface MaskedText {
  /** The text with every span replaced by its placeholder. */
  masked: string;
  /** `spans[n - 1]` is what `⟦n⟧` stands for. */
  spans: string[];
}

interface Range {
  start: number;
  end: number;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** Fenced blocks, line by line: an unclosed fence runs to the end. */
const fenceRanges = (text: string): Range[] => {
  const ranges: Range[] = [];
  let open: { start: number; marker: string } | null = null;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);
    if (open === null) {
      const match = FENCE_OPEN.exec(line);
      if (match) open = { start: lineStart, marker: match[1] };
    } else {
      const char = open.marker[0];
      const close = new RegExp(
        `^ {0,3}\\${char}{${open.marker.length},}[ \\t]*$`,
      );
      if (close.test(line)) {
        ranges.push({ start: open.start, end: lineEnd });
        open = null;
      }
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  if (open !== null) ranges.push({ start: open.start, end: text.length });
  return ranges;
};

const B = '(?<![\\p{L}\\p{N}_])';
const E = '(?![\\p{L}\\p{N}_])';
/** Characters a URL or path token may hold (no space, quote, bracket or backtick). */
const TOKEN = '[^\\s()\\[\\]{}<>"\'`]';
/** Not the last character of a URL or path: sentence punctuation. */
const TAIL = '[^\\s()\\[\\]{}<>"\'`.,;:!?]';
/** ASCII characters a path token may hold. */
const PATH_CHAR = '[A-Za-z0-9_.~:@%+=,;!?#$&*^|\\/\\\\-]';
/** Not the last character of a path: sentence punctuation. */
const PATH_TAIL = '[A-Za-z0-9_~@%+=#$&*^|\\/\\\\-]';

const SPAN_PATTERNS = [
  // Inline code.
  '``[^\\n]+?``',
  '`[^`\\n]+`',
  // A placeholder-shaped text already in the input.
  '⟦[^⟧\\n]*⟧',
  // URLs.
  `(?:[A-Za-z][A-Za-z0-9+.-]*://|www\\.)(?:${TOKEN}*${TAIL})?`,
  // E-mail addresses.
  `${B}[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}${E}`,
  // Paths: an ASCII token holding a slash or a backslash.
  `(?<![^\\s(\\[{<"'])(?:${PATH_CHAR}*${PATH_TAIL})?[\\/\\\\](?:${PATH_CHAR}*${PATH_TAIL})?(?![^\\s()\\[\\]{}<>"'\`.,;:!?])`,
  // Dotfiles: `.env`, `.github`.
  `(?<![^\\s(\\[{<"'])\\.[A-Za-z0-9][A-Za-z0-9_.-]*[A-Za-z0-9]`,
  // References: #123, C-12.
  `(?<![\\p{L}\\p{N}_#])#\\d+${E}`,
  `${B}[A-Z]{1,10}-\\d+${E}`,
  // Mentions.
  `(?<![\\p{L}\\p{N}_@.])@[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?${E}`,
  // Dotted identifiers: a.b.c, name.ext.
  `${B}[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z0-9_$]+)+${E}`,
  // snake_case and SCREAMING_CASE.
  `${B}_*[A-Za-z][A-Za-z0-9]*(?:_+[A-Za-z0-9]+)+_*${E}`,
  // camelCase.
  `${B}[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*${E}`,
  // PascalCase with an inner capital (PrismaService, iOS-style names).
  `${B}[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*${E}`,
];

const SPAN = new RegExp(SPAN_PATTERNS.join('|'), 'gu');

const inlineRanges = (text: string, from: number, to: number): Range[] => {
  const segment = text.slice(from, to);
  const ranges: Range[] = [];
  for (const match of segment.matchAll(SPAN)) {
    if (match[0].length === 0) continue;
    const start = from + (match.index ?? 0);
    ranges.push({ start, end: start + match[0].length });
  }
  return ranges;
};

/** Replaces every code-like span of `text` with a numbered placeholder. */
export const maskText = (text: string): MaskedText => {
  const fences = fenceRanges(text);
  const ranges: Range[] = [];
  let cursor = 0;
  for (const fence of fences) {
    ranges.push(...inlineRanges(text, cursor, fence.start), fence);
    cursor = fence.end;
  }
  ranges.push(...inlineRanges(text, cursor, text.length));

  const spans: string[] = [];
  let masked = '';
  cursor = 0;
  for (const range of ranges) {
    masked += text.slice(cursor, range.start);
    spans.push(text.slice(range.start, range.end));
    masked += textPlaceholder(spans.length);
    cursor = range.end;
  }
  masked += text.slice(cursor);
  return { masked, spans };
};

/**
 * Whether `output` holds every placeholder `⟦1⟧ … ⟦count⟧` exactly once and
 * no other placeholder (D6). A field that fails is `rejected`.
 */
export const checkPlaceholders = (output: string, count: number): boolean => {
  const seen = new Set<number>();
  for (const match of output.matchAll(TEXT_PLACEHOLDER_PATTERN)) {
    const n = Number(match[1]);
    if (!Number.isSafeInteger(n) || n < 1 || n > count || seen.has(n)) {
      return false;
    }
    seen.add(n);
  }
  return seen.size === count;
};

/**
 * Puts `spans` back in place of their placeholders. Call it only on a text
 * that passed `checkPlaceholders`; an unknown placeholder is left as it is.
 */
export const unmaskText = (masked: string, spans: readonly string[]): string =>
  masked.replace(
    TEXT_PLACEHOLDER_PATTERN,
    (whole, n: string) => spans[Number(n) - 1] ?? whole,
  );
