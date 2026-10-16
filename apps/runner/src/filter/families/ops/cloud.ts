import type { Filter } from '../../types';
import {
  cleanLines,
  collapseRepeats,
  elide,
  hasFlag,
  joinLines,
  looksLikeJson,
  positionals,
} from './util';

/**
 * aws and gcloud. Their JSON, YAML and `--query` output is what an agent
 * parses, so it is never shortened; the filters cover only the human
 * progress output — `aws s3` transfers and `aws logs tail`, and gcloud's
 * build / deploy / list text.
 */

const AWS_VALUE_FLAGS = [
  '--profile',
  '--region',
  '--endpoint-url',
  '--output',
  '--query',
  '--cli-read-timeout',
  '--cli-connect-timeout',
];

const awsWords = (argv: readonly string[]) =>
  positionals(argv, AWS_VALUE_FLAGS);

const S3_TRANSFERS = new Set(['cp', 'sync', 'mv', 'rm']);

/** `upload: ./a to s3://b/a`, `download:`, `delete:`, `copy:`, `move:`. */
const S3_LINE = /^(upload|download|delete|copy|move|remove): /;

const s3Filter = (output: string): string | null => {
  const lines = cleanLines(output);
  const transfers = lines.filter((l) => S3_LINE.test(l));
  if (transfers.length < 6) return null;
  const counts = new Map<string, number>();
  for (const l of transfers) {
    const verb = l.slice(0, l.indexOf(':'));
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }
  const summary = [...counts].map(([verb, n]) => `${n} ${verb}`).join(', ');
  const rest = lines.filter((l) => !S3_LINE.test(l));
  return joinLines([
    ...transfers.slice(0, 3),
    `… ${transfers.length - 3} more transfers (${summary}) …`,
    ...rest,
  ]);
};

export const awsFilter: Filter = {
  id: 'ops/aws',
  matches: (argv) => {
    if (argv[0] !== 'aws') return false;
    const [service, verb] = awsWords(argv);
    return (
      (service === 's3' && S3_TRANSFERS.has(verb ?? '')) ||
      (service === 'logs' && verb === 'tail')
    );
  },
  longRunning: (argv) => {
    const [service, verb] = awsWords(argv);
    return service === 'logs' && verb === 'tail' && hasFlag(argv, '--follow');
  },
  apply: ({ argv, output }) => {
    const [service] = awsWords(argv);
    if (service === 's3') return s3Filter(output);
    return joinLines(
      elide(collapseRepeats(cleanLines(output)), { head: 20, tail: 80 }),
    );
  },
};

const GCLOUD_SKIP = new Set([
  'auth',
  'init',
  'config',
  'components',
  'feedback',
]);

const gcloudWords = (argv: readonly string[]) =>
  positionals(argv, [
    '--project',
    '--account',
    '--format',
    '--filter',
    '--region',
    '--zone',
  ]);

export const gcloudFilter: Filter = {
  id: 'ops/gcloud',
  matches: (argv) =>
    argv[0] === 'gcloud' &&
    !GCLOUD_SKIP.has(gcloudWords(argv)[0] ?? '') &&
    !gcloudWords(argv).includes('ssh'),
  longRunning: (argv) =>
    hasFlag(argv, '--stream', '--follow', '--stream-logs') ||
    gcloudWords(argv).includes('tail'),
  apply: ({ argv, output }) => {
    if (looksLikeJson(output) || hasFlag(argv, '--format')) return null;
    return joinLines(
      elide(collapseRepeats(cleanLines(output)), { head: 60, tail: 30 }),
    );
  },
};
