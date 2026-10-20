import type {
  CardPrCloseArgs,
  CardPrCloseResult,
  WatchedProject,
} from '@nautelle/shared/protocol';
import { z } from 'zod';
import { watchedProject } from '../control/target';
import type { Exec } from '../detect/exec';
import { redactUrlUserinfo } from '../redact-url';
import { githubOf } from '../skills/run/collect';
import {
  type BranchOutcome,
  deleteHeadBranch,
  firstLine,
  type Gh,
  ghOf,
  PR_HEAD_FIELDS,
  parsed,
  prHeadSchema,
} from './github';

export interface CardPrCloseDeps {
  exec: Exec;
  watchedProjects: () => readonly WatchedProject[];
}

const prViewSchema = prHeadSchema.extend({ state: z.string() });

const issueViewSchema = z.looseObject({ state: z.string() });

/**
 * #329 D8 (ADR-0010): Accept without merging closes a board card's PR
 * through `gh` — `gh pr close <pr> --repo <o/r> --comment <comment>`, an
 * argument array — then deletes its head branch (`deleteBranch`, as
 * `card.merge` does) and closes `issue` as not planned when it is still open.
 * A merged PR is refused; one closed already is a success, and the branch
 * and issue steps still run. A refusal is a result — nothing was closed —
 * never a thrown command error, except for a target that is not a watched
 * project.
 */
export const closeCardPr = async (
  args: CardPrCloseArgs,
  deps: CardPrCloseDeps,
): Promise<CardPrCloseResult> => {
  const project = watchedProject(args, deps.watchedProjects());
  const gh = ghOf(deps.exec);
  const pr = String(args.pr);
  let github: string;
  try {
    github = await githubOf(deps, project);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      closed: false,
      error: 'gh_failed',
      message: redactUrlUserinfo((message.split('\n')[0] ?? '').slice(0, 500)),
    };
  }
  const viewed = await gh([
    'pr',
    'view',
    pr,
    '--repo',
    github,
    '--json',
    `state,${PR_HEAD_FIELDS}`,
  ]);
  const view = viewed?.code === 0 ? parsed(prViewSchema, viewed.stdout) : null;
  if (!view) {
    return { closed: false, error: 'gh_failed', message: firstLine(viewed) };
  }
  if (view.state === 'MERGED') {
    return {
      closed: false,
      error: 'merged',
      message: `pull request #${pr} is merged`,
    };
  }
  const alreadyClosed = view.state !== 'OPEN';
  if (!alreadyClosed) {
    const closed = await gh([
      'pr',
      'close',
      pr,
      '--repo',
      github,
      '--comment',
      args.comment,
    ]);
    if (closed?.code !== 0) {
      return { closed: false, error: 'gh_failed', message: firstLine(closed) };
    }
  }
  const branch: BranchOutcome = args.deleteBranch
    ? await deleteHeadBranch(gh, github, view)
    : { branchDeleted: false };
  return {
    closed: true,
    alreadyClosed,
    ...branch,
    ...(await closeIssueNotPlanned(gh, github, args)),
  };
};

/**
 * `issueClosed` is whether this call closed it: an issue closed before — by
 * anyone, for any reason — is left as it is and reads `false`.
 */
const closeIssueNotPlanned = async (
  gh: Gh,
  github: string,
  args: CardPrCloseArgs,
): Promise<{ issueClosed: boolean; issueError?: string }> => {
  if (args.issue === null) return { issueClosed: false };
  const issue = String(args.issue);
  const viewed = await gh([
    'issue',
    'view',
    issue,
    '--repo',
    github,
    '--json',
    'state',
  ]);
  const state =
    viewed?.code === 0 ? parsed(issueViewSchema, viewed.stdout)?.state : null;
  if (!state) return { issueClosed: false, issueError: firstLine(viewed) };
  if (state !== 'OPEN') return { issueClosed: false };
  const closed = await gh([
    'issue',
    'close',
    issue,
    '--repo',
    github,
    '--reason',
    'not planned',
    '--comment',
    args.comment,
  ]);
  return closed?.code === 0
    ? { issueClosed: true }
    : { issueClosed: false, issueError: firstLine(closed) };
};
