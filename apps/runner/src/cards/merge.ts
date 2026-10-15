import type {
  CardMergeArgs,
  CardMergeFailReason,
  CardMergeMethod,
  CardMergeResult,
  WatchedProject,
} from '@agentdock/shared/protocol';
import { z } from 'zod';
import { watchedProject } from '../control/target';
import type { Exec, ExecResult } from '../detect/exec';
import { GH_TIMEOUT_MS } from '../skills/deps';
import { githubOf } from '../skills/run/collect';

export interface CardMergeDeps {
  exec: Exec;
  watchedProjects: () => readonly WatchedProject[];
}

/** The order GitHub's own merge button offers the methods in (#273 D12). */
const METHOD_ORDER: readonly CardMergeMethod[] = ['merge', 'squash', 'rebase'];

const prViewSchema = z.looseObject({
  state: z.string(),
  headRefOid: z.string(),
  mergeCommit: z.looseObject({ oid: z.string() }).nullish(),
});

const repoViewSchema = z.looseObject({
  mergeCommitAllowed: z.boolean(),
  squashMergeAllowed: z.boolean(),
  rebaseMergeAllowed: z.boolean(),
});

const issueViewSchema = z.looseObject({ state: z.string() });

const SHA = /^[0-9a-f]{40}$/;

/** `gh`'s first line of complaint, at most 500 characters. */
const firstLine = (result: ExecResult | null): string => {
  if (!result) return 'gh is not available or timed out';
  const line = `${result.stderr}\n${result.stdout}`
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line ?? `gh exited with ${result.code}`).slice(0, 500);
};

class Refused extends Error {
  constructor(
    readonly reason: CardMergeFailReason,
    message: string,
  ) {
    super(message);
  }
}

/** A refused `gh pr merge`: the head moved, GitHub refuses, or anything else. */
const classify = (message: string): CardMergeFailReason => {
  if (
    /head (branch )?(was )?modified|match-head-commit|expected head/i.test(
      message,
    )
  ) {
    return 'head_changed';
  }
  if (
    /mergeable|merge conflict|conflicts|protect|required status|status check|review|not allowed|blocked/i.test(
      message,
    )
  ) {
    return 'not_mergeable';
  }
  return 'gh_failed';
};

const parsed = <T>(schema: z.ZodType<T>, stdout: string): T | null => {
  try {
    const result = schema.safeParse(JSON.parse(stdout));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
};

/**
 * #273 D11–D13 (ADR-0029): merges a board card's PR through `gh`, bound to
 * the head the person saw, then closes the card's issue when it is still
 * open. Every `gh` call is an argument array against the project's GitHub
 * repository; nothing here deletes a branch (D15). A refusal is a result —
 * nothing was merged — never a thrown command error, except for a target
 * that is not a watched project.
 */
export const mergeCard = async (
  args: CardMergeArgs,
  deps: CardMergeDeps,
): Promise<CardMergeResult> => {
  const project = watchedProject(args, deps.watchedProjects());
  const gh = (ghArgs: string[]) =>
    deps.exec('gh', ghArgs, { timeoutMs: GH_TIMEOUT_MS });
  try {
    const github = await githubOf(deps, project);
    const pr = String(args.pr);
    const viewed = await gh([
      'pr',
      'view',
      pr,
      '--repo',
      github,
      '--json',
      'state,headRefOid,mergeCommit',
    ]);
    const view =
      viewed?.code === 0 ? parsed(prViewSchema, viewed.stdout) : null;
    if (!view) throw new Refused('gh_failed', firstLine(viewed));

    const methodOf = async (): Promise<CardMergeMethod> =>
      args.method ?? (await repositoryMethod(gh, github));

    if (view.state === 'MERGED') {
      // Nothing is merged now: an unreadable repository default is only a label.
      const method = await methodOf().catch((): CardMergeMethod => 'merge');
      return {
        merged: true,
        alreadyMerged: true,
        method,
        mergeCommit: shaOf(view.mergeCommit?.oid),
        ...(await closeIssue(gh, github, args)),
      };
    }
    if (view.state !== 'OPEN') {
      throw new Refused('closed', `pull request #${pr} is closed`);
    }
    if (view.headRefOid !== args.headSha) {
      throw new Refused(
        'head_changed',
        `pull request #${pr} is at ${view.headRefOid.slice(0, 12)}, not ${args.headSha.slice(0, 12)}`,
      );
    }
    const method = await methodOf();
    const merged = await gh([
      'pr',
      'merge',
      pr,
      '--repo',
      github,
      `--${method}`,
      '--match-head-commit',
      args.headSha,
    ]);
    if (merged?.code !== 0) {
      const message = firstLine(merged);
      throw new Refused(classify(message), message);
    }
    return {
      merged: true,
      alreadyMerged: false,
      method,
      mergeCommit: await mergeCommitOf(gh, github, pr),
      ...(await closeIssue(gh, github, args)),
    };
  } catch (error) {
    if (error instanceof Refused) {
      return { merged: false, error: error.reason, message: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      merged: false,
      error: 'gh_failed',
      message: (message.split('\n')[0] ?? '').slice(0, 500),
    };
  }
};

type Gh = (args: string[]) => Promise<ExecResult | null>;

const shaOf = (oid: string | undefined): string | null =>
  oid && SHA.test(oid) ? oid : null;

/** D12: the repository's first allowed method, merge → squash → rebase. */
const repositoryMethod = async (
  gh: Gh,
  github: string,
): Promise<CardMergeMethod> => {
  const viewed = await gh([
    'repo',
    'view',
    github,
    '--json',
    'mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed',
  ]);
  const repo =
    viewed?.code === 0 ? parsed(repoViewSchema, viewed.stdout) : null;
  if (!repo) throw new Refused('gh_failed', firstLine(viewed));
  const allowed: Record<CardMergeMethod, boolean> = {
    merge: repo.mergeCommitAllowed,
    squash: repo.squashMergeAllowed,
    rebase: repo.rebaseMergeAllowed,
  };
  const method = METHOD_ORDER.find((m) => allowed[m]);
  if (!method) {
    throw new Refused('not_mergeable', `${github} allows no merge method`);
  }
  return method;
};

/** Best effort: the merge already happened, so a failed read is `null`. */
const mergeCommitOf = async (
  gh: Gh,
  github: string,
  pr: string,
): Promise<string | null> => {
  const viewed = await gh([
    'pr',
    'view',
    pr,
    '--repo',
    github,
    '--json',
    'mergeCommit',
  ]);
  if (viewed?.code !== 0) return null;
  return shaOf(parsed(prViewSchema.partial(), viewed.stdout)?.mergeCommit?.oid);
};

/**
 * D13: `Closes #n` does nothing on a non-default base, so the issue is closed
 * here when it is still open. A failure is reported, never thrown: the PR is
 * merged either way. `issueClosed` is whether the issue is closed now.
 */
const closeIssue = async (
  gh: Gh,
  github: string,
  args: CardMergeArgs,
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
  if (state !== 'OPEN') return { issueClosed: true };
  const closed = await gh([
    'issue',
    'close',
    issue,
    '--repo',
    github,
    '--reason',
    'completed',
    '--comment',
    args.comment,
  ]);
  return closed?.code === 0
    ? { issueClosed: true }
    : { issueClosed: false, issueError: firstLine(closed) };
};
