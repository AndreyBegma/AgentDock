import { isProtectedLine } from '../../classify';
import type { Filter } from '../../types';
import { cleanLines, elide, elideRuns, hasFlag, joinLines } from './util';

/**
 * Listings and searches: find, ls, tree, grep, rg. Short output is left
 * alone. A long listing keeps its head, its tail and every line that is an
 * error or carries a `file:line` location, and says how many lines it left
 * out. Search hits are grouped by file instead (see `searchFilter`).
 *
 * cat and wc are not filtered: cat prints a file the agent asked to read in
 * full, and a cut would read as the file's end; wc prints a line per file and
 * is short already.
 */

interface Listing {
  threshold: number;
  head: number;
  tail: number;
}

const LISTING: Listing = { threshold: 200, head: 120, tail: 40 };
const SEARCH: Listing = { threshold: 300, head: 150, tail: 50 };

const listing =
  (limits: Listing) =>
  (output: string): string | null => {
    const lines = cleanLines(output);
    if (lines.length <= limits.threshold) return null;
    return joinLines(elide(lines, limits));
  };

/** find actions whose output a script parses, or which change the tree. */
const FIND_ACTIONS = [
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-print0',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-printf',
  '-ls',
];

export const findFilter: Filter = {
  id: 'lang/find',
  matches: (argv) => argv[0] === 'find' && !hasFlag(argv, ...FIND_ACTIONS),
  apply: ({ output }) => listing(LISTING)(output),
};

export const lsFilter: Filter = {
  id: 'lang/ls',
  matches: (argv) => argv[0] === 'ls',
  apply: ({ output }) => listing(LISTING)(output),
};

export const treeFilter: Filter = {
  id: 'lang/tree',
  matches: (argv) =>
    argv[0] === 'tree' && !hasFlag(argv, '-J', '--json', '-X', '--xml', '-H'),
  apply: ({ output }) => listing(LISTING)(output),
};

/**
 * Below this, a search goes through unchanged. A dozen hits is what an agent
 * reads in full anyway, and the footer that points to the raw output costs
 * ~150 bytes — most of what grouping a short search could save.
 */
export const SEARCH_MIN_BYTES = 1024;

/** Lines shown per file; the rest are counted. Protected hits always show. */
export const SEARCH_LINES_PER_FILE = 8;

/** A hit's text is cut past this (minified files), unless it is protected. */
const SEARCH_LINE_CHARS = 200;

/** After grouping, a search longer than this keeps its head and tail. */
const SEARCH_MAX_LINES = 200;
const SEARCH_TAIL_LINES = 50;

/** Share of lines that must read as `file:…` hits for the output to be grouped. */
const SEARCH_PARSED_SHARE = 0.9;

/** Modes that print counts or file names, not hits: only capped when long. */
const SEARCH_NAME_MODES = [
  '-c',
  '--count',
  '--count-matches',
  '-l',
  '--files-with-matches',
  '-L',
  '--files-without-match',
  '--files',
  '-h',
  '--no-filename',
];

/** `path:12:text` (a hit) or `path-12-text` (a context line, `-A/-B/-C`). */
const NUMBERED = /^([^\s:][^:]*?)([:-])(\d+)\2(.*)$/;
/** `path:text`, as rg prints a hit without `-n` when piped. */
const BARE = /^((?:[\w.@+-]*\/)+[\w.@+-]+|[\w@+-][\w.@+-]*\.\w+):(.*)$/;

interface Hit {
  file: string;
  /** `12:` for a hit, `12-` for a context line, `` without line numbers. */
  mark: string;
  text: string;
  context: boolean;
  line: string;
}

const parseHit = (line: string, numbered: boolean): Hit | null => {
  if (numbered) {
    const m = NUMBERED.exec(line);
    if (!m) return null;
    const [, file = '', sep = '', n = '', text = ''] = m;
    return {
      file,
      mark: `${n}${sep}`,
      text,
      context: sep === '-',
      line,
    };
  }
  const m = BARE.exec(line);
  if (!m) return null;
  const [, file = '', text = ''] = m;
  return { file, mark: '', text, context: false, line };
};

/**
 * A search hit is judged by its text: its `file:line:` prefix is where the
 * hit is, not a stack frame. Lines of any other shape are judged whole.
 */
export const searchHitText = (line: string): string => {
  const hit = parseHit(line, true) ?? parseHit(line, false);
  return hit ? hit.text : line;
};

const shown = (hit: Hit): string => {
  const text =
    hit.text.length > SEARCH_LINE_CHARS && !isProtectedLine(hit.text)
      ? `${hit.text.slice(0, SEARCH_LINE_CHARS)}…`
      : hit.text;
  return `  ${hit.mark}${text}`;
};

/**
 * grep / rg hits grouped by file (rtk's strategy): the path once, then at
 * most `SEARCH_LINES_PER_FILE` lines of it and a count of the rest. A file
 * with a single hit keeps its line as it was. `null` when the output is not
 * mostly hits.
 */
const groupHits = (lines: readonly string[]): string[] | null => {
  const body = lines.filter((l) => l.trim() !== '' && l !== '--');
  if (body.length === 0) return null;
  const parse = (numbered: boolean) => body.map((l) => parseHit(l, numbered));
  let hits = parse(true);
  const parsed = (all: (Hit | null)[]) =>
    all.filter((h) => h !== null).length / body.length;
  if (parsed(hits) < SEARCH_PARSED_SHARE) hits = parse(false);
  if (parsed(hits) < SEARCH_PARSED_SHARE) return null;

  const other: string[] = [];
  const files = new Map<string, Hit[]>();
  body.forEach((line, i) => {
    const hit = hits[i];
    if (!hit) {
      other.push(line);
      return;
    }
    const group = files.get(hit.file) ?? [];
    group.push(hit);
    files.set(hit.file, group);
  });

  const out = [...other];
  for (const [file, group] of files) {
    if (group.length === 1 && group[0]) {
      out.push(group[0].line);
      continue;
    }
    const count = group.filter((h) => !h.context).length;
    out.push(`${file} (${count} ${count === 1 ? 'hit' : 'hits'})`);
    let hidden = 0;
    group.forEach((hit, i) => {
      if (i < SEARCH_LINES_PER_FILE || isProtectedLine(hit.text)) {
        out.push(shown(hit));
      } else {
        hidden++;
      }
    });
    if (hidden > 0) out.push(`  … ${hidden} more lines`);
  }
  return out;
};

const searchOutput = (argv: readonly string[], output: string) => {
  if (Buffer.byteLength(output) < SEARCH_MIN_BYTES) return null;
  const lines = cleanLines(output);
  const grouped = hasFlag(argv, ...SEARCH_NAME_MODES) ? null : groupHits(lines);
  if (!grouped) return listing(SEARCH)(output);
  if (grouped.length <= SEARCH_MAX_LINES) return joinLines(grouped);
  const head = SEARCH_MAX_LINES - SEARCH_TAIL_LINES;
  return joinLines(
    elideRuns(
      grouped,
      grouped.map(
        (line, i) =>
          i < head ||
          i >= grouped.length - SEARCH_TAIL_LINES ||
          isProtectedLine(searchHitText(line)),
      ),
    ),
  );
};

/**
 * grep and rg. Hits are grouped by file and capped per file; counts and file
 * lists are only capped when long. Short searches are left alone.
 */
export const searchFilter: Filter = {
  id: 'lang/search',
  matches: (argv) =>
    ['grep', 'egrep', 'fgrep', 'rg'].includes(argv[0] ?? '') &&
    !hasFlag(argv, '--json', '-0', '--null', '-Z', '--files-with-matches0'),
  protectedPart: searchHitText,
  apply: ({ argv, output }) => searchOutput(argv, output),
};
