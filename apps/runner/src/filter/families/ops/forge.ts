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
 * `issue view` drop empty fields and comment markup and cap the body; and
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
const VIEW_HEAD = 60;
const VIEW_TAIL = 15;

/** A `key:<TAB>value` field above the first `--`; one with no value says nothing. */
const EMPTY_FIELD = /^[a-z][a-z -]*:\t*\s*$/;

/**
 * A `pr view` / `issue view` as gh prints it to a pipe: `key:<TAB>value`
 * fields, `--`, the body (and, with `--comments`, each comment the same way).
 * Empty fields, HTML comments and repeated blank lines go; a long body keeps
 * its head and tail.
 */
const viewFilter = (output: string): string => {
  const lines: string[] = [];
  let inComment = false;
  let inFields = true;
  for (const line of cleanLines(output)) {
    if (line === '--') inFields = false;
    const opens = line.includes('<!--');
    const closes = line.includes('-->');
    if (inComment || (opens && line.trim().startsWith('<!--'))) {
      inComment = !closes;
      if (isProtectedLine(line)) lines.push(line);
      continue;
    }
    if (inFields && EMPTY_FIELD.test(line)) continue;
    lines.push(line);
  }
  return joinLines(
    elide(squeezeBlanks(collapseRepeats(lines)), {
      head: VIEW_HEAD,
      tail: VIEW_TAIL,
    }),
  );
};

/** `gh run view --log`: `job<TAB>step<TAB>2026-10-17T09:00:00.0000000Z text`. */
const RUN_LOG = /^([^\t]+)\t([^\t]*)\t\d{4}-\d\d-\d\dT[\d:.]+Z ?(.*)$/;

/** Lines of a failed step shown before and after the cut. */
const FAILED_STEP_HEAD = 10;
const FAILED_STEP_TAIL = 40;

/** The log's last lines, shown whatever step they are in. */
export const RUN_LOG_TAIL = 15;

/**
 * A run log (rtk's strategy): one line per step that passed, the failed
 * steps — a step with an error or warning line — up to a cap, and the log's
 * tail. A step's lines lose their `job / step / timestamp` prefix under the
 * step's header; a protected line keeps it, as it was printed.
 */
const runLogFilter = (output: string): string | null => {
  const lines = cleanLines(output);
  const parsed = lines.map((l) => RUN_LOG.exec(l));
  if (parsed.filter(Boolean).length < lines.length * 0.9) return null;
  interface Step {
    name: string;
    lines: { raw: string; text: string }[];
    failed: boolean;
  }
  const steps: Step[] = [];
  const tailFrom = Math.max(0, lines.length - RUN_LOG_TAIL);
  const tail: string[] = [];
  lines.forEach((raw, i) => {
    const m = parsed[i];
    const name = m ? `${m[1]} / ${m[2]}` : (steps.at(-1)?.name ?? '');
    let step = steps.at(-1);
    if (!step || step.name !== name) {
      step = { name, lines: [], failed: false };
      steps.push(step);
    }
    step.lines.push({ raw, text: m ? (m[3] ?? '') : raw });
    if (isProtectedLine(raw)) step.failed = true;
    if (i >= tailFrom) tail.push(raw);
  });
  const out: string[] = [];
  let shownUpTo = 0;
  let at = 0;
  for (const step of steps) {
    const first = at;
    at += step.lines.length;
    if (!step.failed) {
      out.push(`${step.name}: ${step.lines.length} lines`);
      continue;
    }
    out.push(
      `${step.name}: ${step.lines.length} lines, with errors or warnings`,
    );
    const shown = step.lines.map(({ raw, text }) =>
      isProtectedLine(raw) ? raw : `  ${text}`,
    );
    out.push(
      ...elide(shown, { head: FAILED_STEP_HEAD, tail: FAILED_STEP_TAIL }),
    );
    shownUpTo = Math.max(shownUpTo, first + step.lines.length);
  }
  const rest = tail.slice(Math.max(0, shownUpTo - tailFrom));
  if (rest.length > 0) out.push(`last ${rest.length} lines:`, ...rest);
  return joinLines(out);
};

const forgeFilter = (id: string, program: string): Filter => ({
  id,
  matches: matchesForge(program),
  longRunning: (argv) =>
    hasFlag(argv, ...WATCHING) || words(argv)[1] === 'watch',
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
      return viewFilter(output);
    }
    return listing(output);
  },
});

export const ghFilter = forgeFilter('ops/gh', 'gh');
export const glabFilter = forgeFilter('ops/glab', 'glab');
