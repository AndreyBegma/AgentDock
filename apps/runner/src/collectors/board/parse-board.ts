import type { BoardRow, RoundDecisions } from '@agentdock/shared/protocol';

/** The header line of a board, minus what the file name already says. */
export interface BoardHeader {
  date: string;
  round: string;
  repo: string;
  base: string;
  occupied: number;
  max: number;
  free: number;
}

export type Parsed<T> =
  | { ok: true; value: T }
  | { ok: false; line?: number; reason: string };

export const fail = (reason: string, line?: number): Parsed<never> => ({
  ok: false,
  reason,
  ...(line ? { line } : {}),
});

/** `# Round <date> <HHMM> · <owner/repo> · base <base> · occupied <n>/<max> · free <m>` */
const HEADER =
  /^#\s+Round\s+(\d{4}-\d{2}-\d{2})\s+(\d{4})\s*·\s*(\S+)\s*·\s*base\s+(\S+)\s*·\s*occupied\s+(\d+)\s*\/\s*(\d+)\s*·\s*free\s+(\d+)\s*$/i;

/** The four tables of orchestrator Phase 5, by the start of their heading. */
const TABLES: readonly [RegExp, keyof RoundDecisions][] = [
  [/^dispatching\b/i, 'dispatching'],
  [/^held for a lead\b/i, 'heldForLead'],
  [/^not dispatching\b/i, 'notDispatching'],
  [/^already in flight\b/i, 'inFlight'],
];

/** The cells of a markdown table row; `\|` stays inside its cell. */
export const tableCells = (line: string): string[] => {
  const body = line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '');
  return body.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
};

const isRow = (line: string) => line.trim().startsWith('|');
const isSeparator = (line: string) =>
  /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line.trim());

/** A table's rows keyed by its header cells as written; extra cells are kept as `col<n>`. */
const readTable = (
  lines: readonly string[],
  start: number,
): Parsed<{ rows: BoardRow[]; end: number }> => {
  const headers = tableCells(lines[start]);
  if (start + 1 >= lines.length || !isSeparator(lines[start + 1])) {
    return fail('table header is not followed by a separator row', start + 2);
  }
  const rows: BoardRow[] = [];
  let i = start + 2;
  for (; i < lines.length && isRow(lines[i]); i++) {
    const cells = tableCells(lines[i]);
    const row: BoardRow = {};
    cells.forEach((cell, n) => {
      row[headers[n] || `col${n + 1}`] = cell;
    });
    for (const header of headers.slice(cells.length)) row[header] = '';
    rows.push(row);
  }
  return { ok: true, value: { rows, end: i } };
};

/**
 * Parses `round-<HHMM>.md` (spec 11 D4): the header line and the four tables.
 * Other sections (notes, the log) are ignored; a table missing from the board
 * is `[]`. Anything structurally wrong is a failure with the line it is on —
 * the caller reports it as `board.unparsed`, never throws.
 */
export const parseBoard = (
  text: string,
): Parsed<{ header: BoardHeader; decisions: RoundDecisions }> => {
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim().length > 0);
  if (first === -1) return fail('the board is empty');
  const match = HEADER.exec(lines[first].trim());
  if (!match) return fail('no round header line', first + 1);
  const header: BoardHeader = {
    date: match[1],
    round: match[2],
    repo: match[3],
    base: match[4],
    occupied: Number(match[5]),
    max: Number(match[6]),
    free: Number(match[7]),
  };

  const decisions: RoundDecisions = {
    dispatching: [],
    heldForLead: [],
    notDispatching: [],
    inFlight: [],
  };
  let table: keyof RoundDecisions | null = null;
  let read = false;
  for (let i = first + 1; i < lines.length; i++) {
    const heading = /^##\s+(.+?)\s*$/.exec(lines[i]);
    if (heading) {
      table = TABLES.find(([p]) => p.test(heading[1]))?.[1] ?? null;
      read = false;
      continue;
    }
    if (!table || read || !isRow(lines[i])) continue;
    const parsed = readTable(lines, i);
    if (!parsed.ok) return parsed;
    decisions[table] = parsed.value.rows;
    read = true;
    i = parsed.value.end - 1;
  }
  return { ok: true, value: { header, decisions } };
};
