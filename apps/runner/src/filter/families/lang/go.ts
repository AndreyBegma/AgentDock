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
 * go test: the `=== RUN` / `--- PASS` stream of -v, packages without tests and
 * the per-package `ok` lines go; failures, panics and logs stay.
 */

const RUN_NOISE = /^(=== (RUN|PAUSE|CONT|NAME)\b|\s*--- (PASS|SKIP): )/;
const NO_TESTS = /^\?\s+\S+\s+\[no test files\]/;
const OK_PACKAGE = /^ok\s+\S+\s+(\S+|\(cached\))/;
const KNOWN = /^(ok|FAIL|\?|PASS|---|===)\b/;

const goCommand = (argv: readonly string[]): string | undefined => {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('-')) return arg;
  }
  return undefined;
};

export const goTestFilter: Filter = {
  id: 'lang/go-test',
  matches: (argv) =>
    argv[0] === 'go' && goCommand(argv) === 'test' && !hasFlag(argv, '-json'),
  // A fuzzing run goes on until it finds something or its time is up.
  longRunning: (argv) => hasFlag(argv, '-fuzz'),
  apply: ({ output }) => {
    if (looksLikeJson(output)) return null;
    const lines = cleanLines(output);
    if (!lines.some((l) => KNOWN.test(l))) return null;

    const dropped = dropNoise(lines, RUN_NOISE);
    const withoutEmpty = dropped.filter(
      (l) => !NO_TESTS.test(l) || /\b(error|fail)/i.test(l),
    );
    const okCount = withoutEmpty.filter((l) => OK_PACKAGE.test(l)).length;
    const out: string[] = [];
    let summarised = false;
    for (const line of withoutEmpty) {
      if (okCount > 3 && OK_PACKAGE.test(line)) {
        if (!summarised) {
          out.push(`ok  ${okCount} packages passed`);
          summarised = true;
        }
        continue;
      }
      out.push(line);
    }
    return joinLines(squeezeBlanks(out));
  },
};
