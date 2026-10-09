import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Exec } from '../../detect/exec';
import { CommandFailure } from '../failure';

/**
 * The approval signal the orchestrator reads (spec 20 D5). Everything that
 * knows its path or its spelling is in this file: when plugin#8 settles a
 * different contract, only this module changes.
 *
 * The file is `<git-common-dir>/cs-orchestrator/approvals/<pr>.json`. These
 * writes are the only thing the approval commands do to the disk, and they
 * never leave that directory — `signalPath` is the single place a target is
 * built, and `writeSignal` refuses any target outside it.
 */

export type SignalDecision = 'approved' | 'changes_requested' | 'stale';

export interface Signal {
  v: 1;
  pr: number;
  decision: SignalDecision;
  /** The head the decision binds to (D6). */
  headSha: string;
  note?: string;
  by: string;
  at: string;
}

/** Who a void is attributed to: the API withdraws it, no person does. */
export const VOID_ACTOR = 'agentdock';

export const APPROVALS_DIR = 'approvals';

/** `<git-common-dir>/cs-orchestrator/approvals` of a checkout, via git (fixed argv). */
export const approvalsDirOf = async (
  exec: Exec,
  root: string,
): Promise<string> => {
  const result = await exec('git', [
    '-C',
    root,
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  const commonDir = result?.code === 0 ? result.stdout.trim() : '';
  if (!commonDir) {
    throw new CommandFailure(
      'not_a_repository',
      `${root} is not a git repository`,
    );
  }
  return join(commonDir, 'cs-orchestrator', APPROVALS_DIR);
};

/** The signal file of one PR; the PR number is the only variable part. */
export const signalPath = (approvalsDir: string, pr: number): string => {
  if (!Number.isInteger(pr) || pr <= 0) {
    throw new CommandFailure('path_not_allowed', `${pr} is not a PR number`);
  }
  return join(approvalsDir, `${pr}.json`);
};

const inside = (dir: string, target: string): boolean => {
  const rel = relative(resolve(dir), resolve(target));
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..';
};

/**
 * Writes `signal` for its PR, atomically: a temp file in the same directory,
 * then `rename`, so the orchestrator never reads half a file.
 */
export const writeSignal = async (
  approvalsDir: string,
  signal: Signal,
  /** Test seam: the target the writer is asked for. Default: `signalPath`. */
  target = signalPath(approvalsDir, signal.pr),
): Promise<void> => {
  if (
    !inside(approvalsDir, target) ||
    dirname(resolve(target)) !== resolve(approvalsDir)
  ) {
    throw new CommandFailure(
      'path_not_allowed',
      'a signal is only written inside the approvals directory',
    );
  }
  await mkdir(approvalsDir, { recursive: true });
  const temp = join(
    approvalsDir,
    `.${signal.pr}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temp, `${JSON.stringify(signal, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
};
