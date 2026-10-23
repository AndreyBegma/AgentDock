import { z } from 'zod';
import { firstLine, type Gh, parsed } from '../cards/github';
import { CommandFailure } from '../commands/failure';

const repoDefaultSchema = z.looseObject({
  defaultBranchRef: z.looseObject({ name: z.string() }).nullish(),
});

const branchSchema = z.looseObject({ protected: z.boolean() });

/** GitHub's answer for a branch that does not exist yet. */
const NOT_FOUND = /HTTP 404|Not Found|Branch not found/i;

/**
 * C-148 (L-31, ADR-0077): the runner's guard before it pushes a card or run
 * branch. It reads GitHub live, not the API's word: a push to the
 * repository's default branch, or to a branch GitHub reports as protected,
 * is refused with `branch_refused`. A branch GitHub does not know yet is
 * new, so it is allowed. When GitHub cannot be read the push fails as an
 * ordinary error — retried by the next poll or collect, never let through.
 */
export const assertPushAllowed = async (
  gh: Gh,
  github: string,
  branch: string,
): Promise<void> => {
  const repo = await gh(['repo', 'view', github, '--json', 'defaultBranchRef']);
  const view = repo?.code === 0 ? parsed(repoDefaultSchema, repo.stdout) : null;
  const defaultBranch = view?.defaultBranchRef?.name;
  if (!defaultBranch) {
    throw new Error(
      `could not read the default branch of ${github}: ${firstLine(repo)}`,
    );
  }
  if (branch === defaultBranch) {
    throw new CommandFailure(
      'branch_refused',
      `${branch} is the default branch of ${github}; the runner never pushes to it`,
    );
  }
  const path = branch.split('/').map(encodeURIComponent).join('/');
  const read = await gh(['api', `repos/${github}/branches/${path}`]);
  if (read?.code !== 0) {
    if (read && NOT_FOUND.test(firstLine(read))) return;
    throw new Error(
      `could not read branch ${branch} of ${github}: ${firstLine(read)}`,
    );
  }
  const state = parsed(branchSchema, read.stdout);
  if (!state) throw new Error(`gh api printed no branch for ${branch}`);
  if (state.protected) {
    throw new CommandFailure(
      'branch_refused',
      `${branch} is a protected branch of ${github}; the runner never pushes to it`,
    );
  }
};
