import { isProtectedLine } from '../../classify';
import type { Filter } from '../../types';
import {
  cleanLines,
  collapseRepeats,
  elide,
  hasFlag,
  joinLines,
  looksLikeJson,
  positionals,
  squeezeBlanks,
} from './util';

/**
 * `gh` and `glab`: pr / issue / run / release / workflow listings and views.
 * A listing past a screenful keeps its head and tail; `checks` collapses the
 * passing rows into a count while keeping every other one; `pr view` /
 * `issue view` drop empty fields and markup and cap the body and each
 * comment; and
 * `run view --log` keeps the failed steps and a tail.
 */

/**
 * Below this, forge output goes through unchanged: a PR number, a URL or a
 * short listing is what the agent asked for, and the footer that points to
 * the raw output (~150 bytes) would cost more than it hides.
 */
export const GH_MIN_BYTES = 512;

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

/** Body lines of a `pr view` / `issue view` shown before and after the cut. */
const VIEW_HEAD = 40;
const VIEW_TAIL = 10;

/** Lines shown per comment of `view --comments`; bot reports run long. */
export const COMMENT_LINES = 10;

/** A `key:<TAB>value` field; one with no value says nothing. */
const FIELD = /^[a-z][a-z -]*:\t/;
const EMPTY_FIELD = /^[a-z][a-z -]*:\t*\s*$/;

/** A body without HTML comments, markup-only lines or repeated blank lines. */
const prose = (lines: readonly string[]): string[] => {
  const out: string[] = [];
  let inComment = false;
  for (const line of lines) {
    const text = line.trim();
    if (inComment || text.startsWith('<!--')) {
      inComment = !text.includes('-->');
      if (isProtectedLine(line)) out.push(line);
      continue;
    }
    if (/^(<\/?(details|summary|p|br|div)>\s*)+$/.test(text)) continue;
    if (/^\|?(\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*$/.test(text)) continue;
    out.push(line);
  }
  return squeezeBlanks(collapseRepeats(out));
};

/**
 * A `pr view` / `issue view` as gh prints it to a pipe: `key:<TAB>value`
 * fields, `--`, the body. With `--comments` it prints each comment that
 * way instead, closed by another `--`. Empty fields, HTML comments and
 * table rulers go; the body keeps its head and tail, and each comment its
 * first `COMMENT_LINES` lines.
 */
const viewFilter = (output: string, comments: boolean): string => {
  const out: string[] = [];
  let block: string[] = [];
  let inFields = true;
  const flushBody = () => {
    const body = prose(block);
    out.push(
      ...(comments
        ? elide(body, { head: COMMENT_LINES, tail: 0 })
        : elide(body, { head: VIEW_HEAD, tail: VIEW_TAIL })),
    );
    block = [];
  };
  const lines = cleanLines(output);
  lines.forEach((line, i) => {
    if (inFields) {
      if (line === '--') inFields = false;
      if (!EMPTY_FIELD.test(line)) out.push(line);
      return;
    }
    // A comment's closing `--` is followed by the next comment's fields.
    const next = lines[i + 1];
    if (comments && line === '--' && (next === undefined || FIELD.test(next))) {
      flushBody();
      out.push(line);
      inFields = true;
      return;
    }
    block.push(line);
  });
  flushBody();
  return joinLines(out);
};

/** `gh run view --log`: `job<TAB>step<TAB>2026-10-17T09:00:00.0000000Z text`. */
const RUN_LOG = /^([^\t]+)\t([^\t]*)\t\d{4}-\d\d-\d\dT[\d:.]+Z ?(.*)$/;

/** Lines of a failed step shown before and after the cut. */
const FAILED_STEP_HEAD = 10;
const FAILED_STEP_TAIL = 40;

/** The log's last lines, shown whatever step they are in. */
export const RUN_LOG_TAIL = 15;

/**
 * A run-log line is judged by its text: the `job / step / timestamp`
 * prefix says where it was printed, which the step's header repeats. Lines
 * of any other shape are judged whole.
 */
export const runLogText = (line: string): string =>
  RUN_LOG.exec(line)?.[3] ?? line;

/**
 * A run log (rtk's strategy): one line per step without an error or warning,
 * the steps with one up to a cap, and the log's tail. Lines lose their
 * `job / step / timestamp` prefix under their step's header.
 */
const runLogFilter = (output: string): string | null => {
  const lines = cleanLines(output);
  const parsed = lines.map((l) => RUN_LOG.exec(l));
  if (parsed.filter(Boolean).length < lines.length * 0.9) return null;
  interface Step {
    name: string;
    lines: string[];
    failed: boolean;
  }
  const steps: Step[] = [];
  lines.forEach((raw, i) => {
    const m = parsed[i];
    const name = m ? `${m[1]} / ${m[2]}` : (steps.at(-1)?.name ?? '');
    let step = steps.at(-1);
    if (!step || step.name !== name) {
      step = { name, lines: [], failed: false };
      steps.push(step);
    }
    const text = m ? (m[3] ?? '') : raw;
    step.lines.push(`  ${text}`);
    if (isProtectedLine(text)) step.failed = true;
  });
  const out: string[] = [];
  const tailFrom = Math.max(0, lines.length - RUN_LOG_TAIL);
  let shownUpTo = 0;
  let at = 0;
  for (const step of steps) {
    at += step.lines.length;
    if (!step.failed) {
      out.push(`${step.name}: ${step.lines.length} lines`);
      continue;
    }
    out.push(
      `${step.name}: ${step.lines.length} lines, with errors or warnings`,
    );
    out.push(
      ...elide(step.lines, { head: FAILED_STEP_HEAD, tail: FAILED_STEP_TAIL }),
    );
    shownUpTo = at;
  }
  const tail = steps
    .flatMap((step) => step.lines)
    .slice(Math.max(tailFrom, shownUpTo));
  if (tail.length > 0) out.push(`last ${tail.length} lines:`, ...tail);
  return joinLines(out);
};

const forgeFilter = (id: string, program: string): Filter => ({
  id,
  matches: matchesForge(program),
  longRunning: (argv) =>
    hasFlag(argv, ...WATCHING) || words(argv)[1] === 'watch',
  protectedPart: runLogText,
  apply: ({ argv, output }) => {
    // `--json` and `--template` output is for a parser: never reshaped.
    if (Buffer.byteLength(output) < GH_MIN_BYTES || looksLikeJson(output)) {
      return null;
    }
    if (hasFlag(argv, '--json', '-q', '--jq', '-t', '--template')) return null;
    const [noun, verb] = words(argv);
    if (verb === 'checks') return checksFilter(output) ?? listing(output);
    if (verb === 'view' && hasFlag(argv, '--log', '--log-failed')) {
      return runLogFilter(output) ?? listing(output);
    }
    if (
      verb === 'view' &&
      (noun === 'pr' || noun === 'issue' || noun === 'mr')
    ) {
      return viewFilter(output, hasFlag(argv, '--comments', '-c'));
    }
    return listing(output);
  },
});

export const ghFilter = forgeFilter('ops/gh', 'gh');
export const glabFilter = forgeFilter('ops/glab', 'glab');
