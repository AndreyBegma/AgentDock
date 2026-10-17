import type { Filter } from '../../types';
import { cleanLines, elide, hasFlag, joinLines } from './util';

/**
 * Listings and searches: find, ls, tree, grep, rg. Short output is left
 * alone. A long one keeps its head, its tail and every line that is an error
 * or carries a `file:line` location, and says how many lines it left out.
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

/** Searches that print counts, names only, or one match are short; all else is capped. */
export const searchFilter: Filter = {
  id: 'lang/search',
  matches: (argv) =>
    ['grep', 'egrep', 'fgrep', 'rg'].includes(argv[0] ?? '') &&
    !hasFlag(argv, '--json', '-0', '--null', '-Z', '--files-with-matches0'),
  apply: ({ output }) => listing(SEARCH)(output),
};
