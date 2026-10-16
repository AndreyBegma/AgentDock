import { isProtectedLine } from '../../classify';
import {
  type Compress,
  dropEmptyHeaders,
  finish,
  indentOf,
  isBlank,
  plainLines,
  splitLines,
  survivors,
} from './util';

/**
 * Test runners: jest, vitest, bun test. What goes: passing tests and suites,
 * the source frame around a failure (the `file:line` stack line stays) and
 * coverage rows at 100%. What stays: every failure, its message and diff,
 * stack frames, console output and the summary.
 */

const PASSED_ITEM = /^\s+(✓|✔|√)\s/;
/** `   10 |   code` — a source line around a failure, not the marked one. */
const FRAME_LINE = /^\s+\d+ \|/;
/** `      |      ^^^` — the caret under a source line. */
const FRAME_CARET = /^\s+\|\s+\^+\s*$/;
/** An `All files` coverage row of a file at 100% everywhere. */
const COVERED_ROW =
  /^\s*[^|\s][^|]*\|\s*100\s*\|\s*100\s*\|\s*100\s*\|\s*100\s*\|\s*$/;
const RESULT_ITEM = /^\s+(✓|✔|√|✕|✗|×|○|◌|✎|-)\s/;

const sniff = (lines: readonly string[], ...patterns: RegExp[]): boolean =>
  patterns.every((pattern) => lines.some((line) => pattern.test(line)));

/** Jest: `PASS`/`FAIL` blocks, `✓` items under `--verbose`, `● name` failures. */
export const compressJest: Compress = (output) => {
  const lines = splitLines(output);
  const plain = plainLines(lines);
  if (!sniff(plain, /^Test Suites:/, /^Tests:\s/)) return null;

  const dropped = plain.map(
    (p) =>
      /^PASS\s/.test(p) ||
      /^Snapshots:\s+0 total/.test(p) ||
      /^Ran all test suites/.test(p) ||
      PASSED_ITEM.test(p) ||
      FRAME_LINE.test(p) ||
      FRAME_CARET.test(p) ||
      COVERED_ROW.test(p),
  );

  // Under `--verbose`, a PASS/FAIL block lists the tests up to a blank line.
  // A describe title whose tests all went has nothing left to say.
  let inList = false;
  const titles: number[] = [];
  for (let i = 0; i < plain.length; i++) {
    const p = plain[i] ?? '';
    if (/^(PASS|FAIL)\s/.test(p)) {
      inList = true;
      continue;
    }
    if (isBlank(p)) inList = false;
    if (inList && /^\s{2,}\S/.test(p) && !RESULT_ITEM.test(p)) titles.push(i);
  }
  for (const i of titles.reverse()) {
    const indent = indentOf(plain[i] ?? '');
    let end = i + 1;
    while (
      end < plain.length &&
      !isBlank(plain[end] ?? '') &&
      indentOf(plain[end] ?? '') > indent
    ) {
      end++;
    }
    if (end === i + 1) continue;
    let empty = true;
    for (let k = i + 1; k < end && empty; k++) {
      empty = dropped[k] === true && !/[✕✗×]/.test(plain[k] ?? '');
    }
    if (empty) dropped[i] = true;
  }
  return finish(output, survivors(lines, dropped));
};

/** Vitest: ` ✓ file (n tests)` per file, `FAIL file > test` with a diff. */
export const compressVitest: Compress = (output) => {
  const lines = splitLines(output);
  const plain = plainLines(lines);
  if (!sniff(plain, /^\s*Test Files\s/, /^\s*Tests\s/)) return null;
  const dropped = plain.map(
    (p) =>
      PASSED_ITEM.test(p) ||
      /^\s*\d+\|/.test(p) ||
      /^\s+\|\s*\^+\s*$/.test(p) ||
      /^\s*RUN\s+v\d/.test(p) ||
      /^\s*Start at\s/.test(p) ||
      /^⎯+(\[\d+\/\d+\]⎯)?\s*$/.test(p) ||
      COVERED_ROW.test(p),
  );
  // `Duration  3.1s (transform 1.4s, setup 0ms, …)`: the total is enough.
  const kept = survivors(lines, dropped).map((line) =>
    isProtectedLine(line)
      ? line
      : line.replace(/^(\s*Duration\s+\S+) \(.*\)\s*$/, '$1'),
  );
  return finish(output, kept);
};

/**
 * Bun test: without a terminal it prints no `(pass)` lines, but the file
 * headers, source frames and `(pass)` lines of a CI-style run do go.
 */
export const compressBunTest: Compress = (output) => {
  const lines = splitLines(output);
  const plain = plainLines(lines);
  if (!sniff(plain, /^Ran \d+ tests? across \d+ files?/)) return null;
  const dropped = plain.map(
    (p) =>
      /^\((pass|skip|todo)\)\s/.test(p) ||
      /^bun test v\d/.test(p) ||
      /^\s*\d+ expect\(\) calls\s*$/.test(p) ||
      /^\s*\d+ \| /.test(p) ||
      /^\s*\^+\s*$/.test(p),
  );
  dropEmptyHeaders(
    lines,
    dropped,
    (p) => /^\S.*:$/.test(p) && !/^(error|warn|#)/i.test(p),
    (p) => /^\S.*:$/.test(p) || /^\s*\d+ (pass|skip|todo|fail)\b/.test(p),
  );
  return finish(output, survivors(lines, dropped));
};
