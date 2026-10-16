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
 * kubectl and helm. A listing keeps its header and a screenful of rows, logs
 * keep their tail, `apply` collapses the unchanged objects into a count, and
 * helm's NOTES block is replaced by a marker (the raw file has it).
 */

const KUBE_VALUE_FLAGS = [
  '-n',
  '--namespace',
  '--context',
  '--cluster',
  '--user',
  '--kubeconfig',
  '-s',
  '--server',
  '-l',
  '--selector',
  '-o',
  '--output',
  '-f',
  '--filename',
  '-c',
  '--container',
  '--tail',
  '--since',
];

const KUBE_VERBS = new Set([
  'get',
  'describe',
  'logs',
  'apply',
  'delete',
  'rollout',
  'top',
  'events',
]);

const kubeWords = (argv: readonly string[]) =>
  positionals(argv, KUBE_VALUE_FLAGS);

const asStructured = (argv: readonly string[]) => {
  const index = argv.findIndex((a) => a === '-o' || a.startsWith('--output'));
  const value =
    argv[index]?.includes('=') === true
      ? (argv[index]?.split('=')[1] ?? '')
      : (argv[index + 1] ?? '');
  return /^(json|yaml|jsonpath|go-template|custom-columns|template)/.test(
    value,
  );
};

const UNCHANGED = /^\S+\/\S+ unchanged$/;

const applyFilter = (output: string): string | null => {
  const lines = cleanLines(output);
  const unchanged = lines.filter((l) => UNCHANGED.test(l)).length;
  if (unchanged < 3) return null;
  return joinLines([
    ...lines.filter((l) => !UNCHANGED.test(l)),
    `${unchanged} objects unchanged`,
  ]);
};

const listing = (output: string, head: number, tail: number): string =>
  joinLines(elide(cleanLines(output), { head, tail }));

export const kubectlFilter: Filter = {
  id: 'ops/kubectl',
  matches: (argv) =>
    (argv[0] === 'kubectl' || argv[0] === 'oc') &&
    KUBE_VERBS.has(kubeWords(argv)[0] ?? ''),
  longRunning: (argv) => {
    const [verb] = kubeWords(argv);
    if (verb === 'logs') return hasFlag(argv, '-f', '--follow');
    if (verb === 'get' || verb === 'events') {
      return hasFlag(argv, '-w', '--watch', '--watch-only');
    }
    return false;
  },
  apply: ({ argv, output }) => {
    const [verb] = kubeWords(argv);
    // Structured output is what the agent will parse: never shorten it.
    if (asStructured(argv) || looksLikeJson(output)) return null;
    switch (verb) {
      case 'apply':
      case 'delete':
        return applyFilter(output) ?? listing(output, 40, 15);
      case 'logs':
        return joinLines(
          elide(collapseRepeats(cleanLines(output)), { head: 20, tail: 80 }),
        );
      case 'describe':
        return joinLines(
          elide(squeezeBlanks(cleanLines(output)), { head: 60, tail: 50 }),
        );
      default:
        return listing(output, 50, 15);
    }
  },
};

const HELM_VERBS = new Set([
  'list',
  'ls',
  'install',
  'upgrade',
  'uninstall',
  'status',
  'history',
  'dependency',
  'dep',
  'repo',
]);

const helmWords = (argv: readonly string[]) =>
  positionals(argv, ['-n', '--namespace', '--kube-context', '-f', '--values']);

/** Drops the NOTES block, which `helm install` prints at the end. */
const withoutNotes = (lines: readonly string[]): string[] | null => {
  const at = lines.findIndex((l) => l === 'NOTES:');
  if (at < 0) return null;
  const notes = lines.slice(at + 1);
  const important = notes.filter((l) => isProtectedLine(l));
  return [
    ...lines.slice(0, at),
    `NOTES: ${notes.length} lines hidden`,
    ...important,
  ];
};

export const helmFilter: Filter = {
  id: 'ops/helm',
  matches: (argv) =>
    argv[0] === 'helm' && HELM_VERBS.has(helmWords(argv)[0] ?? ''),
  apply: ({ argv, output }) => {
    if (looksLikeJson(output) || hasFlag(argv, '-o', '--output')) return null;
    const lines = squeezeBlanks(cleanLines(output));
    const trimmed = withoutNotes(lines) ?? lines;
    return joinLines(elide(trimmed, { head: 40, tail: 15 }));
  },
};
