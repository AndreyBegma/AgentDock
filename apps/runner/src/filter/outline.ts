/**
 * The file outline a 400-line read guard refusal carries (#747 D9), ported
 * from the code-sentinel plugin's `eco_hook.py` `outline()` so the two give the
 * same entries on the same file: Markdown headings outside code fences, or the
 * unindented declaration lines of code, each with its line number.
 */

/** At most this many entries; more are sampled evenly. */
export const OUTLINE_MAX = 40;
/** A code entry is cut to this many characters. */
const ENTRY_CHARS = 120;

const MARKDOWN = ['.md', '.mdx', '.markdown', '.rst'];

const CODE_PREFIXES = [
  'def ',
  'async def ',
  'class ',
  'function ',
  'async function ',
  'export ',
  'interface ',
  'type ',
  'enum ',
  'struct ',
  'impl ',
  'trait ',
  'fn ',
  'pub ',
  'func ',
  'module ',
  'package ',
  'const ',
  'let ',
  'var ',
  'public ',
  'private ',
  'protected ',
  'abstract ',
  '@',
  'describe(',
  'test(',
  'it(',
];

/** Python's `str.splitlines()` boundaries, so line numbers match the plugin. */
const BREAK_CODES = new Set([
  0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029,
]);

const splitLines = (text: string): string[] => {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!BREAK_CODES.has(text.charCodeAt(i))) continue;
    lines.push(text.slice(start, i));
    if (text.charCodeAt(i) === 0x0d && text.charCodeAt(i + 1) === 0x0a) i++;
    start = i + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
};

export interface Outline {
  /** `[line number, text]`, at most `OUTLINE_MAX`. */
  entries: Array<[number, string]>;
  /** How many entries were left out by sampling. */
  more: number;
}

const cut = (text: string): string =>
  Array.from(text).slice(0, ENTRY_CHARS).join('');

export const outline = (text: string, path: string): Outline => {
  const markdown = MARKDOWN.some((ext) => path.toLowerCase().endsWith(ext));
  const found: Array<[number, string]> = [];
  let inFence = false;
  splitLines(text).forEach((line, index) => {
    const n = index + 1;
    if (markdown) {
      if (line.startsWith('```')) {
        inFence = !inFence;
        return;
      }
      if (!inFence && line.startsWith('#') && /^#+ /.test(line)) {
        found.push([n, line.trim()]);
      }
      return;
    }
    const first = line[0];
    if (
      first !== undefined &&
      first !== ' ' &&
      first !== '\t' &&
      CODE_PREFIXES.some((prefix) => line.startsWith(prefix))
    ) {
      found.push([n, cut(line.trim())]);
    }
  });
  const more = Math.max(0, found.length - OUTLINE_MAX);
  if (more === 0) return { entries: found, more };
  const step = found.length / OUTLINE_MAX;
  const sampled: Array<[number, string]> = [];
  for (let i = 0; i < OUTLINE_MAX; i++) {
    const entry = found[Math.floor(i * step)];
    if (entry) sampled.push(entry);
  }
  return { entries: sampled, more };
};

/** The outline as the refusal prints it. */
export const renderOutline = (text: string, path: string): string[] => {
  const { entries, more } = outline(text, path);
  if (entries.length === 0) {
    return ['No outline (no headings or top-level declarations found).'];
  }
  return [
    'Outline:',
    ...entries.map(([n, line]) => `  ${n}: ${line}`),
    ...(more > 0 ? [`  (${more} more, sampled)`] : []),
  ];
};
