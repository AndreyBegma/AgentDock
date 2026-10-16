import type { Filter } from '../../types';
import {
  cleanLines,
  dedupe,
  dropNoise,
  joinLines,
  squeezeBlanks,
} from './util';

/**
 * dotnet build / test / restore / publish / pack: the restore and project
 * chatter goes, the diagnostics MSBuild prints twice are printed once, and
 * test counts and failures stay.
 */

const NOISE =
  /^\s*(Determining projects to restore|Restored \S+|All projects are up-to-date for restore|Restore (complete|succeeded)|Build started|MSBuild version|Test run for |VSTest version|Starting test execution|A total of \d+ test files|Passed \S+ \[)|^\s+\S+ -> \S+|^Welcome to \.NET|^Microsoft \(R\) /;
const KNOWN =
  /^(Build succeeded\.|Build FAILED\.)|^(Passed|Failed)!\s+- |Determining projects to restore|Restore (complete|succeeded)/;

const COMMANDS = new Set(['build', 'test', 'restore', 'publish', 'pack']);

export const dotnetFilter: Filter = {
  id: 'lang/dotnet',
  matches: (argv) =>
    argv[0] === 'dotnet' &&
    COMMANDS.has(argv.slice(1).find((a) => !a.startsWith('-')) ?? ''),
  apply: ({ output }) => {
    const lines = cleanLines(output);
    if (!lines.some((l) => KNOWN.test(l))) return null;
    return joinLines(squeezeBlanks(dedupe(dropNoise(lines, NOISE))));
  },
};
