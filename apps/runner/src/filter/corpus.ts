import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { missingProtectedLines } from './classify';
import { filterFooter, findFilter, judge } from './engine';
import type { Filter } from './types';

/**
 * The regression corpus (#445 D4d): real command outputs, one case per pair
 * of files in `families/<family>/corpus/`:
 *
 * - `<case>.json` — `{ "argv": [...], "exitCode": 1, "category": "test",
 *   "outcome": "failing", "expect": "filtered" }`;
 * - `<case>.out` — the output exactly as the command printed it.
 *
 * `category` is `test` (test runners), `typecheck` (type checkers and
 * linters) or `other`; only the first two count toward the savings medians.
 * `expect: "filtered"` makes a case fail when the filter returns the original
 * — use it for every case a filter is written for.
 */

export type CorpusCategory = 'test' | 'typecheck' | 'other';
export type CorpusOutcome = 'failing' | 'passing';

export interface CorpusCase {
  name: string;
  argv: string[];
  exitCode: number;
  category: CorpusCategory;
  outcome: CorpusOutcome;
  expect: 'filtered' | 'any';
  output: string;
}

export interface CorpusResult {
  case: CorpusCase;
  filter: string | null;
  /** What the agent would read: the compressed output, or the original. */
  kept: string;
  filtered: boolean;
  /** Protected lines of the original missing from `kept`; must be empty. */
  missing: string[];
  ratio: number;
}

/** A stand-in for the raw file's path in compressed outputs. */
const CORPUS_RAW_PATH = '<run dir>/raw/1.log';

const CATEGORIES = new Set<CorpusCategory>(['test', 'typecheck', 'other']);
const OUTCOMES = new Set<CorpusOutcome>(['failing', 'passing']);

/** Reads every case of one corpus directory; a malformed case throws. */
export const loadCorpus = (dir: string): CorpusCase[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((file) => {
      const name = file.slice(0, -'.json'.length);
      const meta = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<
        string,
        unknown
      >;
      const { argv, exitCode, category, outcome } = meta;
      if (
        !Array.isArray(argv) ||
        argv.length === 0 ||
        !argv.every((a) => typeof a === 'string') ||
        typeof exitCode !== 'number' ||
        !CATEGORIES.has(category as CorpusCategory) ||
        !OUTCOMES.has(outcome as CorpusOutcome)
      ) {
        throw new Error(`corpus case ${join(dir, file)} is malformed`);
      }
      return {
        name,
        argv: argv as string[],
        exitCode,
        category: category as CorpusCategory,
        outcome: outcome as CorpusOutcome,
        expect: meta.expect === 'filtered' ? 'filtered' : 'any',
        output: readFileSync(join(dir, `${name}.out`), 'utf8'),
      };
    });
};

/** Runs one case through the same checks the engine applies. */
export const runCorpusCase = (
  filters: readonly Filter[],
  c: CorpusCase,
): CorpusResult => {
  const filter = findFilter(filters, c.argv);
  const verdict = filter
    ? judge(filter, c.argv, c.output, c.exitCode, (hidden) =>
        filterFooter(hidden, CORPUS_RAW_PATH, false),
      )
    : null;
  const kept = verdict?.kind === 'filtered' ? verdict.text : c.output;
  const raw = Buffer.byteLength(c.output);
  return {
    case: c,
    filter: filter?.id ?? null,
    kept,
    filtered: verdict?.kind === 'filtered',
    missing: missingProtectedLines(c.output, kept),
    ratio: raw === 0 ? 1 : Buffer.byteLength(kept) / raw,
  };
};

export const median = (values: readonly number[]): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? Number.NaN)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

/** The savings ceilings (acceptance criteria): median kept/raw. */
export const SAVINGS_CEILING: Record<CorpusOutcome, number> = {
  failing: 0.3,
  passing: 0.1,
};

/**
 * The median kept/raw of the test-runner and type-checker cases with one
 * outcome, or `null` when there are none.
 */
export const savingsMedian = (
  results: readonly CorpusResult[],
  outcome: CorpusOutcome,
): number | null => {
  const ratios = results
    .filter(
      (r) =>
        r.case.outcome === outcome &&
        (r.case.category === 'test' || r.case.category === 'typecheck'),
    )
    .map((r) => r.ratio);
  return ratios.length === 0 ? null : median(ratios);
};
