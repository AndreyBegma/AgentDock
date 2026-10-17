import type { Filter } from '../../types';
import {
  cleanLines,
  collapseRepeats,
  elide,
  joinLines,
  positionals,
} from './util';

/**
 * make: the `Entering/Leaving directory` bookkeeping goes, a long build keeps
 * its head, its tail and every diagnostic line.
 */

const MAKE_VALUE_FLAGS = ['-C', '-f', '-j', '-I', '-o', '-W', '-l', '-E'];

/** Targets that start a server or a watcher and never return. */
const SERVING = new Set([
  'dev',
  'serve',
  'server',
  'watch',
  'run',
  'start',
  'up',
  'dev-server',
]);

const DIRECTORY = /^make(\[\d+\])?: (Entering|Leaving) directory /;

export const makeFilter: Filter = {
  id: 'ops/make',
  matches: (argv) => argv[0] === 'make' || argv[0] === 'gmake',
  longRunning: (argv) =>
    positionals(argv, MAKE_VALUE_FLAGS).some((t) => SERVING.has(t)),
  apply: ({ output }) => {
    const lines = cleanLines(output).filter((l) => !DIRECTORY.test(l));
    return joinLines(elide(collapseRepeats(lines), { head: 10, tail: 25 }));
  },
};
