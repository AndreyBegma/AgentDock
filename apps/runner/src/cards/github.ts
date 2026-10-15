import { z } from 'zod';
import type { Exec, ExecResult } from '../detect/exec';
import { GH_TIMEOUT_MS } from '../skills/deps';

/** One `gh` call, an argument array, under the network timeout. */
export type Gh = (args: string[]) => Promise<ExecResult | null>;

export const ghOf =
  (exec: Exec): Gh =>
  (args) =>
    exec('gh', args, { timeoutMs: GH_TIMEOUT_MS });

/** `gh`'s first line of complaint, at most 500 characters. */
export const firstLine = (result: ExecResult | null): string => {
  if (!result) return 'gh is not available or timed out';
  const line = `${result.stderr}\n${result.stdout}`
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line ?? `gh exited with ${result.code}`).slice(0, 500);
};

export const parsed = <T>(schema: z.ZodType<T>, stdout: string): T | null => {
  try {
    const result = schema.safeParse(JSON.parse(stdout));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
};

/** What `gh pr view --json` must read for `deleteHeadBranch`. */
export const PR_HEAD_FIELDS =
  'headRefName,headRefOid,baseRefName,isCrossRepository';

export const prHeadSchema = z.looseObject({
  headRefName: z.string().min(1),
  headRefOid: z.string(),
  baseRefName: z.string().min(1),
  isCrossRepository: z.boolean(),
});
export type PrHead = z.infer<typeof prHeadSchema>;

const repoDefaultSchema = z.looseObject({
  defaultBranchRef: z.looseObject({ name: z.string() }).nullish(),
});

const refSchema = z.looseObject({
  object: z.looseObject({ sha: z.string() }),
});

/** GitHub's answer for a ref that does not exist. */
const GONE = /HTTP 404|Not Found|Reference does not exist/i;

export interface BranchOutcome {
  branchDeleted: boolean;
  branchError?: string;
}

const refused = (message: string): BranchOutcome => ({
  branchDeleted: false,
  branchError: message.slice(0, 500),
});

/**
 * #329 D7/D8: deletes a PR's head branch on GitHub — the head read from the
 * PR itself, never a name from the API. Left in place, with the reason as
 * `branchError`: a head in a fork, a head that is the PR's base or the
 * repository's default branch, and a branch that moved past the PR's head
 * (someone still pushes to it). A branch already gone (the repository
 * deletes merged heads itself) is `branchDeleted`. Never throws.
 */
export const deleteHeadBranch = async (
  gh: Gh,
  github: string,
  head: PrHead,
): Promise<BranchOutcome> => {
  const branch = head.headRefName;
  if (head.isCrossRepository) {
    return refused(`${branch} is in a fork; left in place`);
  }
  if (branch === head.baseRefName) {
    return refused(`${branch} is the base; left in place`);
  }
  const repo = await gh(['repo', 'view', github, '--json', 'defaultBranchRef']);
  const repoView =
    repo?.code === 0 ? parsed(repoDefaultSchema, repo.stdout) : null;
  if (!repoView) return refused(firstLine(repo));
  if (branch === repoView.defaultBranchRef?.name) {
    return refused(`${branch} is the default branch; left in place`);
  }

  const path = branch.split('/').map(encodeURIComponent).join('/');
  const read = await gh(['api', `repos/${github}/git/ref/heads/${path}`]);
  if (read?.code !== 0) {
    return read && GONE.test(firstLine(read))
      ? { branchDeleted: true }
      : refused(firstLine(read));
  }
  const ref = parsed(refSchema, read.stdout);
  if (!ref) return refused(`gh api printed no ref for ${branch}`);
  if (ref.object.sha !== head.headRefOid) {
    return refused(
      `${branch} moved past the pull request's head; left in place`,
    );
  }
  const deleted = await gh([
    'api',
    '-X',
    'DELETE',
    `repos/${github}/git/refs/heads/${path}`,
  ]);
  if (deleted?.code === 0) return { branchDeleted: true };
  return deleted && GONE.test(firstLine(deleted))
    ? { branchDeleted: true }
    : refused(firstLine(deleted));
};
