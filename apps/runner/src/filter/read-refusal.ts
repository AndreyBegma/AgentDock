import type { HookCommand } from './shell';

/**
 * #663 D8 (ADR-0068): a whole-file read through Bash — `cat f`, `head -50 f`,
 * `tail -n 20 f`, `sed -n 1,80p f` — bypasses both the read guard and Claude
 * Code's own Read dedup, so the hook refuses it and points to `Read`.
 * Only the plain single-file forms are refused: pipelines (`cat a | grep x`),
 * lists, other programs (`wc -l f`, `jq . f`), globs, `-f` follows and
 * anything the parser does not understand pass.
 */

export const READ_REFUSAL_ID = 'tool/read-refused';
export const READ_REFUSAL_MESSAGE =
  'Use Read with offset/limit instead of cat/head/tail/sed -n on a single file: Read is deduplicated and guarded, a Bash read is not.';

const COUNT = /^[1-9][0-9]*$/;
const SED_RANGE = /^[1-9][0-9]*(,[1-9][0-9]*)?p$/;
const UNREADABLE_BY_READ = /[*?[\]{}]|^\/(dev|proc|sys)\//;

/** The one file operand, or `null` when this is not a plain whole-file read. */
const singleFile = (operands: readonly string[]): string | null => {
  const [file, ...rest] = operands;
  if (file === undefined || rest.length > 0) return null;
  if (file === '-' || file.startsWith('-')) return null;
  return UNREADABLE_BY_READ.test(file) ? null : file;
};

/** Whether `argv` is `cat|head|tail|sed -n` on one plain file. */
export const isWholeFileRead = (argv: readonly string[]): boolean => {
  const [program, ...args] = argv;
  if (program === 'cat') return singleFile(args) !== null;
  if (program === 'head' || program === 'tail') {
    const [first, second, ...rest] = args;
    // `head -50 f`, `head -n 50 f`, `head f`
    if (first !== undefined && /^-[1-9][0-9]*$/.test(first)) {
      return (
        singleFile([second, ...rest].filter((w) => w !== undefined)) !== null
      );
    }
    if (first === '-n' && second !== undefined && COUNT.test(second)) {
      return singleFile(rest) !== null;
    }
    return singleFile(args) !== null;
  }
  if (program === 'sed') {
    const [flag, script, ...rest] = args;
    if (flag !== '-n' || script === undefined || !SED_RANGE.test(script)) {
      return false;
    }
    return singleFile(rest) !== null;
  }
  return false;
};

/** Whether the whole line is one refused read — one pipeline of one stage. */
export const isRefusedRead = (parsed: HookCommand | null): boolean => {
  if (!parsed || parsed.operators.length > 0) return false;
  const [pipeline] = parsed.pipelines;
  if (parsed.pipelines.length !== 1 || pipeline?.length !== 1) return false;
  const stage = pipeline[0];
  if (!stage || stage.command.assignments.length > 0) return false;
  return isWholeFileRead(stage.command.argv);
};
