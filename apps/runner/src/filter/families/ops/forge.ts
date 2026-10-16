import type { Filter } from '../../types';
import {
  cleanLines,
  collapseRepeats,
  elide,
  hasFlag,
  joinLines,
  positionals,
  squeezeBlanks,
} from './util';

/**
 * `gh` and `glab`: pr / issue / run / release / workflow listings and views.
 * A listing past a screenful keeps its head and tail, and `checks` collapses
 * the passing rows into a count while keeping every other one.
 */

const NOUNS = new Set([
  'pr',
  'mr',
  'issue',
  'run',
  'release',
  'workflow',
  'ci',
  'pipeline',
  'repo',
]);
const VERBS = new Set(['list', 'view', 'checks', 'status', 'diff', 'ls']);

const GH_VALUE_FLAGS = ['-R', '--repo', '-b', '--branch', '-L', '--limit'];

const words = (argv: readonly string[]) => positionals(argv, GH_VALUE_FLAGS);

const WATCHING = ['--watch', '-w', '--follow', '--live'];

const matchesForge = (name: string) => (argv: readonly string[]) => {
  if (argv[0] !== name) return false;
  const [noun, verb] = words(argv);
  return NOUNS.has(noun ?? '') && VERBS.has(verb ?? '');
};

/** `gh pr checks` rows: `name<TAB>pass|fail|pending|skipping<TAB>time<TAB>url`. */
const PASSING_ROW = /^.+\t(pass|skipping)\t/;

const checksFilter = (output: string): string | null => {
  const lines = cleanLines(output);
  const passing = lines.filter((l) => PASSING_ROW.test(l));
  if (passing.length < 3) return null;
  const rest = lines.filter((l) => !PASSING_ROW.test(l));
  return joinLines([...rest, `${passing.length} checks passing or skipped`]);
};

const listing = (output: string): string =>
  joinLines(
    elide(squeezeBlanks(collapseRepeats(cleanLines(output))), {
      head: 40,
      tail: 15,
    }),
  );

const forgeFilter = (id: string, program: string): Filter => ({
  id,
  matches: matchesForge(program),
  longRunning: (argv) =>
    hasFlag(argv, ...WATCHING) || words(argv)[1] === 'watch',
  apply: ({ argv, output }) => {
    const [, verb] = words(argv);
    if (verb === 'checks') return checksFilter(output) ?? listing(output);
    return listing(output);
  },
});

export const ghFilter = forgeFilter('ops/gh', 'gh');
export const glabFilter = forgeFilter('ops/glab', 'glab');
