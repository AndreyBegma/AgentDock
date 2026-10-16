import { isProtectedLine } from '../../classify';
import type { Filter } from '../../types';
import {
  cleanLines,
  collapseRepeats,
  elide,
  hasFlag,
  joinLines,
  squeezeBlanks,
} from './util';

/**
 * docker / docker compose: build, pull, push, logs, ps, images, up, down.
 * `run`, `exec`, `attach` and `compose run` are interactive and never match.
 */

const DOCKER_VALUE_FLAGS = [
  '--context',
  '-c',
  '-H',
  '--host',
  '--log-level',
  '-l',
  '-f',
  '--file',
  '-p',
  '--project-name',
  '--env-file',
  '--profile',
  '--project-directory',
];

/**
 * The words that name the command: `ps`, `compose up`, `image pull`. Flags
 * that take a value are skipped only ahead of the verb, because `-f` means
 * "compose file" there and "follow" after `logs`.
 */
const dockerWords = (argv: readonly string[]): string[] => {
  const out: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const needed = argv[0] === 'docker' && out[0] === 'compose' ? 2 : 1;
    if (out.length < needed && DOCKER_VALUE_FLAGS.includes(arg)) {
      i++;
      continue;
    }
    if (!arg.startsWith('-')) out.push(arg);
  }
  return out;
};

const COMPOSE_VERBS = new Set([
  'build',
  'pull',
  'push',
  'logs',
  'ps',
  'up',
  'down',
  'images',
]);
const NOUN_VERBS = new Set(['build', 'pull', 'push', 'logs', 'ps', 'images']);

/** The verb of a command this filter covers, or `null`. */
const verbOf = (argv: readonly string[]): string | null => {
  const [first, second] = dockerWords(argv);
  if (argv[0] === 'docker-compose') {
    return first && COMPOSE_VERBS.has(first) ? first : null;
  }
  if (argv[0] !== 'docker') return null;
  if (first === 'compose') {
    return second && COMPOSE_VERBS.has(second) ? second : null;
  }
  if (first === 'buildx') return second === 'build' ? 'build' : null;
  // `docker image pull`, `docker container logs`
  if (first === 'image' || first === 'container') {
    return second && NOUN_VERBS.has(second) ? second : null;
  }
  return first && NOUN_VERBS.has(first) ? first : null;
};

/**
 * The legacy builder's `Step 3/8` chatter. BuildKit's `#12 [3/8] RUN …`
 * output is not shortened: the classifier reads every `#N …` line as a
 * backtrace frame (`#0  main () at …`), so none of it may be dropped, and the
 * engine would hand the original back. Returning `null` says so up front.
 */
const buildFilter = (output: string): string | null => {
  const lines = cleanLines(output);
  if (!lines.some((l) => /^Step \d+\/\d+ : /.test(l))) return null;
  const out = lines.filter(
    (line) =>
      isProtectedLine(line) ||
      !(/^ ---> /.test(line) || /^Removing intermediate container/.test(line)),
  );
  return joinLines(squeezeBlanks(out));
};

/** Per-layer chatter of a pull or push; the digest and status stay. */
const LAYER =
  /^[0-9a-f]{6,}: (Pulling fs layer|Waiting|Downloading|Verifying Checksum|Download complete|Extracting|Pull complete|Preparing|Layer already exists|Pushed|Mounted from|Pushing)\b/;

const transferFilter = (output: string): string | null => {
  const lines = cleanLines(output);
  const layers = lines.filter((l) => LAYER.test(l)).length;
  if (layers === 0) return null;
  const rest = lines.filter((l) => !LAYER.test(l));
  return joinLines(squeezeBlanks([...rest, `(${layers} layer steps hidden)`]));
};

const logLines = (output: string): string =>
  joinLines(elide(collapseRepeats(cleanLines(output)), { head: 30, tail: 60 }));

const tableFilter = (output: string): string | null => {
  const lines = cleanLines(output);
  return lines.length <= 60
    ? null
    : joinLines(elide(lines, { head: 40, tail: 10 }));
};

export const dockerFilter: Filter = {
  id: 'ops/docker',
  matches: (argv) => verbOf(argv) !== null,
  longRunning: (argv) => {
    const verb = verbOf(argv);
    if (verb === 'logs') return hasFlag(argv, '-f', '--follow');
    // `compose up` stays attached to its containers unless told to detach.
    if (verb === 'up') return !hasFlag(argv, '-d', '--detach', '--wait');
    return false;
  },
  apply: ({ argv, output }) => {
    switch (verbOf(argv)) {
      case 'build':
        return buildFilter(output);
      case 'pull':
      case 'push':
        return transferFilter(output) ?? logLines(output);
      case 'ps':
      case 'images':
        return tableFilter(output);
      default:
        return logLines(output);
    }
  },
};
