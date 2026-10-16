import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CardDraftPullRequest } from '@agentdock/shared/protocol';
import { GH_TIMEOUT_MS, gitOk, parsePrUrl, stderrLine } from '../skills/deps';
import { githubOf, pushBranch } from '../skills/run/collect';
import {
  fallbackPullRequestBody,
  type GitDeps,
  type OpenPr,
  openPullRequest,
} from './git';
import type { CardRecord } from './record';
import { commitsWithTrailer, type TrailerCommit } from './trailer-guard';

/**
 * #359 D1: what one push step did. `pushed` is a new head on origin; `pr` the
 * open PR of the branch, or null when finding or opening it failed (`prError`)
 * — the head stays pushed and the PR is tried again on a later poll.
 * #447 D7: `held` — the trailer guard found these commits and nothing was
 * pushed or opened (`pushed: false`, `pr: null`).
 */
export interface PushStep {
  headSha: string;
  pushed: boolean;
  pr: (OpenPr & { opened: boolean }) | null;
  prError?: string;
  held?: TrailerCommit[];
}

type PushRecord = Pick<
  CardRecord,
  | 'projectId'
  | 'root'
  | 'worktree'
  | 'branch'
  | 'base'
  | 'specFiles'
  | 'pullRequest'
  | 'pushedHead'
  | 'pushPr'
>;

/**
 * What a push step would do, from the worktree alone (no network): null when
 * there is nothing to do — no draft PR asked for, the checkout is on another
 * branch, HEAD is not ahead of `origin/<base>`, or HEAD is pushed and its PR
 * known. Only the committed HEAD counts; the index and the working tree are
 * never looked at.
 */
export const pendingPush = async (
  deps: GitDeps,
  record: PushRecord,
): Promise<{ headSha: string; push: boolean } | null> => {
  if (!record.pullRequest || record.branch === record.base) return null;
  const wt = record.worktree;
  const current = await deps.exec('git', [
    '-C',
    wt,
    'symbolic-ref',
    '--quiet',
    '--short',
    'HEAD',
  ]);
  if (current?.code !== 0 || current.stdout.trim() !== record.branch) {
    return null;
  }
  const headSha = (
    await gitOk(deps.exec, ['-C', wt, 'rev-parse', 'HEAD'])
  ).trim();
  const ahead = await deps.exec('git', [
    '-C',
    wt,
    'rev-list',
    '--count',
    `refs/remotes/origin/${record.base}..HEAD`,
  ]);
  if (ahead?.code !== 0 || !(Number(ahead.stdout.trim()) > 0)) return null;
  const push = headSha !== record.pushedHead;
  if (!push && record.pushPr) return null;
  return { headSha, push };
};

/** `gh pr create --draft`, the body in a private temporary file, never argv. */
const createDraftPullRequest = async (
  deps: GitDeps,
  pr: { github: string; base: string; branch: string } & CardDraftPullRequest,
): Promise<{ number: number; url: string }> => {
  const dir = mkdtempSync(join(deps.tempRoot ?? tmpdir(), 'agentdock-pr-'));
  try {
    const bodyFile = join(dir, 'body.md');
    writeFileSync(bodyFile, pr.body, { mode: 0o600 });
    const created = await deps.exec(
      'gh',
      [
        'pr',
        'create',
        '--draft',
        '--repo',
        pr.github,
        '--base',
        pr.base,
        '--head',
        pr.branch,
        '--title',
        pr.title,
        '--body-file',
        bodyFile,
      ],
      { timeoutMs: GH_TIMEOUT_MS },
    );
    if (!created || created.code !== 0) {
      throw new Error(`gh pr create failed: ${stderrLine(created)}`);
    }
    const parsed = parsePrUrl(created.stdout);
    if (!parsed) throw new Error('gh pr create printed no pull request URL');
    return parsed;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const oneLine = (error: unknown): string =>
  (
    (error instanceof Error ? error.message : String(error)).split('\n')[0] ??
    ''
  ).slice(0, 500);

/**
 * #359 D1: pushes the committed HEAD of the card's branch — `git push origin
 * HEAD:refs/heads/<branch>`, without the project's hooks and never forced —
 * and, when no PR is open for the branch, opens the round's draft one, its
 * body led by the spec link (as every card PR body is). Null when
 * `pendingPush` finds nothing to do. A failed push throws; a failed PR is
 * `prError`.
 */
export const pushCardHead = async (
  deps: GitDeps,
  record: PushRecord,
  options: { trailerGuard?: boolean } = {},
): Promise<PushStep | null> => {
  const pending = await pendingPush(deps, record);
  const draft = record.pullRequest;
  if (!pending || !draft) return null;
  // #447 D7: nothing is pushed while a commit to push carries a trailer.
  if (pending.push && options.trailerGuard) {
    const held = await commitsWithTrailer(
      deps,
      record.worktree,
      record.branch,
      record.base,
    );
    if (held.length > 0) {
      return { headSha: pending.headSha, pushed: false, pr: null, held };
    }
  }
  const github = await githubOf(deps, {
    id: record.projectId,
    root: record.root,
  });
  if (pending.push) await pushBranch(deps, record.worktree, record.branch);
  try {
    const open = await openPullRequest(deps, github, record.branch);
    const pr = open
      ? {
          ...open,
          opened: record.pushPr?.number === open.number && record.pushPr.opened,
        }
      : {
          ...(await createDraftPullRequest(deps, {
            github,
            base: record.base,
            branch: record.branch,
            title: draft.title,
            body: fallbackPullRequestBody(
              draft.body,
              github,
              record.branch,
              record.specFiles ?? [],
            ),
          })),
          state: 'draft' as const,
          opened: true,
        };
    return { headSha: pending.headSha, pushed: pending.push, pr };
  } catch (error) {
    return {
      headSha: pending.headSha,
      pushed: pending.push,
      pr: null,
      prError: oneLine(error),
    };
  }
};
