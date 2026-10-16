import { isProtectedLine } from '../../classify';
import type { Filter } from '../../types';
import {
  cleanLines,
  dropNoise,
  effective,
  elideRuns,
  hasFlag,
  joinLines,
  looksLikeJson,
  squeezeBlanks,
} from './util';

/**
 * pytest and ruff. pytest keeps its header, every failure with the failing
 * line and its assertion detail, and the summary; passing results and
 * progress go. ruff keeps each diagnostic's location and message and drops
 * the source snippet.
 */

const SECTION = /^=+ (.+?) =+$/;
const SUMMARY_WORDS =
  /\b(passed|failed|errors?|skipped|deselected|warnings?|xfailed|xpassed|no tests ran)\b/;
const IN_SECONDS = /\bin \d+(\.\d+)?s\b/;

const isSummary = (line: string): boolean =>
  SUMMARY_WORDS.test(line) && IN_SECONDS.test(line);

/** One verbose result line: `tests/test_a.py::test_x PASSED   [ 12%]`. */
const VERBOSE_OK = /^\S+::\S.* (PASSED|SKIPPED|XFAIL|XPASS)\b/;
/** A progress line: `tests/test_a.py ....s..  [ 12%]`, or `...F.` under -q. */
const PROGRESS = /^(\S+\.py )?[.sxXFE]+\s*(\[\s*\d+%\])?$/;

const FAILURE_HEADER = /^_{2,} .+ _{2,}$/;
const CAPTURED = /^-{2,} (Captured|.*\bcaptured\b).* -{2,}$/i;

/** Marks the lines of a FAILURES / ERRORS section that carry the failure. */
const failureKeep = (lines: readonly string[]): boolean[] => {
  const kept = lines.map(
    (line) =>
      FAILURE_HEADER.test(line) ||
      CAPTURED.test(line) ||
      line.startsWith('>') ||
      isProtectedLine(line),
  );
  // The two lines above a failing `>` line are the code that leads to it.
  lines.forEach((line, i) => {
    if (!line.startsWith('>')) return;
    for (let back = 1; back <= 2; back++) {
      if (i - back >= 0 && lines[i - back]?.trim() !== '')
        kept[i - back] = true;
    }
  });
  // The first lines of a captured stream say what the test printed.
  let sinceCaptured = Number.POSITIVE_INFINITY;
  lines.forEach((line, i) => {
    if (CAPTURED.test(line)) sinceCaptured = 0;
    else if (FAILURE_HEADER.test(line))
      sinceCaptured = Number.POSITIVE_INFINITY;
    else sinceCaptured++;
    if (sinceCaptured <= 6) kept[i] = true;
  });
  return kept;
};

const pytestApply = (output: string, passed: boolean): string | null => {
  if (looksLikeJson(output)) return null;
  const lines = cleanLines(output);
  if (!lines.some(isSummary)) return null;
  if (
    !lines.some((l) => /^=+ test session starts =+$/.test(l)) &&
    !lines.some((l) => PROGRESS.test(l) || VERBOSE_OK.test(l))
  ) {
    return null;
  }

  const out: string[] = [];
  let section = 'session';
  let body: string[] = [];
  const flush = () => {
    if (body.length === 0) return;
    if (section === 'FAILURES' || section === 'ERRORS') {
      out.push(...elideRuns(body, failureKeep(body)));
    } else if (section === 'short test summary info') {
      out.push(...body);
    } else {
      // session header and warnings: what the classifier protects and every
      // line that is not indented source stays; indented runs are elided
      const kept = body.map((l) => isProtectedLine(l) || !/^\s{2,}/.test(l));
      out.push(...elideRuns(body, kept));
    }
    body = [];
  };
  // A green run needs the count and the result, not where pytest looked.
  const isNoise = (line: string): boolean =>
    line.trim() === '' ||
    (passed && /^(rootdir: |configfile: |testpaths: |inifile: )/.test(line)) ||
    /^(platform |cachedir: |plugins: |hypothesis profile|benchmark: |metadata: )/.test(
      line,
    ) ||
    (VERBOSE_OK.test(line) && !isProtectedLine(line)) ||
    (PROGRESS.test(line) && !isProtectedLine(line));

  for (const line of lines) {
    const heading = SECTION.exec(line);
    if (heading && !isSummary(line)) {
      flush();
      section = heading[1] ?? '';
      if (/^slowest \d+ durations$/.test(section)) section = 'durations';
      if (section === 'test session starts') {
        section = 'session';
        if (passed) continue;
      }
      out.push(line);
      continue;
    }
    if (isSummary(line) && heading) {
      flush();
      section = 'summary';
      out.push(line);
      continue;
    }
    if (section === 'durations') continue;
    if (section === 'session' && isNoise(line)) continue;
    body.push(line);
  }
  flush();
  return joinLines(squeezeBlanks(out));
};

const PYTEST_STOPS = ['--pdb', '--trace', '--pdbcls'];

export const pytestFilter: Filter = {
  id: 'lang/pytest',
  matches: (argv) => {
    const cmd = effective(argv);
    const bare = cmd[0] === 'pytest' || cmd[0] === 'py.test';
    // A debugger needs the terminal as it is: never buffer it.
    return bare && !hasFlag(cmd, ...PYTEST_STOPS);
  },
  longRunning: (argv) => hasFlag(effective(argv), '--looponfail', '--pdb'),
  apply: ({ output, exitCode }) => pytestApply(output, exitCode === 0),
};

const DIAGNOSTIC = /^(\S+:\d+:\d+: [A-Z]+\d+ |\s*--> \S+:\d+:\d+)/;
/** The gutter of a source snippet: `  |`, `12 | code`, `  |   ^^^ F401`. */
const GUTTER = /^\s*\d*\s\|(\s.*)?$/;

export const ruffFilter: Filter = {
  id: 'lang/ruff',
  matches: (argv) => {
    const cmd = effective(argv);
    return cmd[0] === 'ruff' && cmd[1] === 'check';
  },
  longRunning: (argv) => hasFlag(effective(argv), '--watch', '-w'),
  apply: ({ output }) => {
    if (looksLikeJson(output)) return null;
    const lines = cleanLines(output);
    if (
      !lines.some((l) => DIAGNOSTIC.test(l)) ||
      !lines.some((l) => GUTTER.test(l))
    ) {
      return null;
    }
    return joinLines(squeezeBlanks(dropNoise(lines, GUTTER)));
  },
};

/** pip's per-package chatter; the install line at the end says what happened. */
const PIP_NOISE =
  /^\s*(Collecting|Downloading|Using cached|Obtaining|Preparing metadata|Getting requirements|Installing build dependencies|Installing backend dependencies|Building wheels? for|Created wheel|Stored in directory|Requirement already satisfied|Looking in indexes|Looking in links|Attempting uninstall|Found existing installation|Uninstalling|Successfully uninstalled|Running setup\.py|Using legacy|Building editable|Building wheel|Installing collected|Running command)\b|[━─]{3,}/;

export const pipFilter: Filter = {
  id: 'lang/pip',
  matches: (argv) => {
    const cmd = effective(argv);
    return (
      (cmd[0] === 'pip' || cmd[0] === 'pip3') &&
      (cmd[1] === 'install' || cmd[1] === 'uninstall')
    );
  },
  apply: ({ output }) => {
    const lines = cleanLines(output);
    const known = lines.some((l) =>
      /^(Collecting|Requirement already satisfied|Successfully installed|Successfully uninstalled|Found existing installation)\b/.test(
        l.trim(),
      ),
    );
    if (!known) return null;
    const kept = dropNoise(lines, PIP_NOISE);
    // A finished install keeps its result line; "Installing collected packages"
    // is dropped above because the result names the same packages.
    return joinLines(squeezeBlanks(kept));
  },
};

const POETRY_NOISE =
  /^\s+[-•] (Downloading|Installing|Updating|Removing|Preparing|Skipping|Locking)\b/;

export const poetryFilter: Filter = {
  id: 'lang/poetry',
  matches: (argv) =>
    argv[0] === 'poetry' &&
    ['install', 'add', 'update', 'remove', 'lock'].includes(argv[1] ?? ''),
  apply: ({ output }) => {
    const lines = cleanLines(output);
    if (
      !lines.some((l) =>
        /^(Package operations:|Installing dependencies|No dependencies to install|Updating dependencies|Resolving dependencies|Writing lock file)/.test(
          l,
        ),
      )
    ) {
      return null;
    }
    return joinLines(squeezeBlanks(dropNoise(lines, POETRY_NOISE)));
  },
};
