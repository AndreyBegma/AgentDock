import { isProtectedLine } from '../../classify';
import type { Filter } from '../../types';
import {
  cleanLines,
  hasFlag,
  joinLines,
  positionals,
  squeezeBlanks,
} from './util';

/**
 * terraform / tofu: init, plan, apply, destroy, validate. The noise is the
 * refresh and provider-install chatter, the "Still creating…" ticks, and the
 * `(known after apply)` attributes of resources about to be created. The
 * resource headers, the changed attributes and the Plan / Apply summaries
 * all stay.
 */

const VERBS = new Set(['init', 'plan', 'apply', 'destroy', 'validate']);

const TF_VALUE_FLAGS = ['-chdir'];

const verbOf = (argv: readonly string[]) =>
  positionals(argv, TF_VALUE_FLAGS)[0];

const NOISE = [
  /: Refreshing state\.\.\./,
  /: Reading\.\.\./,
  /: Read complete after /,
  /: Still (creating|modifying|destroying|reading)\.\.\./,
  /^(Acquiring|Releasing) state lock/,
  /^- (Finding|Installing|Installed|Using previously-installed|Reusing previous version of) /,
  /^\s+# \(\d+ unchanged (attributes|blocks) hidden\)$/,
  /^\s+[+~-]?\s*[\w."[\]-]+\s+= \(known after apply\)$/,
];

export const terraformFilter: Filter = {
  id: 'ops/terraform',
  matches: (argv) =>
    (argv[0] === 'terraform' || argv[0] === 'tofu') &&
    VERBS.has(verbOf(argv) ?? ''),
  // Without -auto-approve or a plan file, apply and destroy wait for a
  // "yes" on stdin; the prompt would sit in the buffer.
  longRunning: (argv) => {
    const verb = verbOf(argv);
    if (verb !== 'apply' && verb !== 'destroy') return false;
    return (
      !hasFlag(argv, '-auto-approve') &&
      !argv.slice(2).some((a) => a.endsWith('.tfplan') || a === 'tfplan')
    );
  },
  apply: ({ argv, output }) => {
    const lines = cleanLines(output);
    const verb = verbOf(argv);
    if (verb === 'validate') return null;
    const kept = lines.filter(
      (line) => isProtectedLine(line) || !NOISE.some((p) => p.test(line)),
    );
    return joinLines(squeezeBlanks(kept));
  },
};
