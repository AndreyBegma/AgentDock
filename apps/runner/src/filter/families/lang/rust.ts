import type { Filter } from '../../types';
import {
  cleanLines,
  dropNoise,
  hasFlag,
  joinLines,
  looksLikeJson,
  squeezeBlanks,
} from './util';

/**
 * cargo build / check / clippy / test: the `Compiling` and `Downloading`
 * stream and the `... ok` test lines go. Compiler diagnostics are kept whole,
 * code snippet and help text included: that is what the agent fixes from.
 */

const CARGO_NOISE =
  /^\s+(Compiling|Downloading|Downloaded|Updating|Locking|Adding|Removing|Fresh|Dirty|Blocking|Checking|Documenting|Packaging|Unpacking|Fetching|Vendoring)\s|^test \S.* \.\.\. (ok|ignored)\b|^running 0 tests$/;
const KNOWN =
  /^\s+(Compiling|Finished|Running|Doc-tests|Checking|Downloaded)\b|^running \d+ tests?$|^test result:|^(warning|error)(\[\w+\])?: /;

const SUBCOMMANDS = new Set([
  'test',
  't',
  'build',
  'b',
  'check',
  'c',
  'clippy',
]);

/** The cargo subcommand, skipping a `+toolchain` and global flags. */
const subcommand = (argv: readonly string[]): string | undefined => {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '-C' || arg === '--manifest-path' || arg === '--config') {
      i++;
      continue;
    }
    if (arg.startsWith('-') || arg.startsWith('+')) continue;
    return arg;
  }
  return undefined;
};

export const cargoFilter: Filter = {
  id: 'lang/cargo',
  matches: (argv) =>
    argv[0] === 'cargo' && SUBCOMMANDS.has(subcommand(argv) ?? ''),
  longRunning: (argv) => hasFlag(argv, '--watch'),
  apply: ({ output }) => {
    if (looksLikeJson(output) || output.trimStart().startsWith('{"'))
      return null;
    const lines = cleanLines(output);
    if (!lines.some((l) => KNOWN.test(l))) return null;
    return joinLines(squeezeBlanks(dropNoise(lines, CARGO_NOISE)));
  },
};
