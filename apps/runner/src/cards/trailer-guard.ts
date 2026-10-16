import { hasClaudeTrailer } from '@agentdock/shared';
import { CommandFailure } from '../commands/failure';
import { gitOk, gitSucceeds } from '../skills/deps';
import type { GitDeps } from './git';

/**
 * #447 D7: the trailer guard. Before the runner pushes a card's commits —
 * the draft push during the round (#359 D1) and `card.collect` — it reads
 * the message of every commit it would push and holds the push when one
 * carries a Claude attribution trailer (`hasClaudeTrailer`). It never
 * rewrites anything: the worker is given the list and rewrites them.
 */

/** A commit the guard holds: its sha and its subject line. */
export interface TrailerCommit {
  sha: string;
  subject: string;
}

/** At most this many commits are named to the worker. */
export const TRAILER_COMMITS_LISTED = 10;

const FIELD = '\u001f';
const RECORD = '\u001e';

/**
 * The commits a push of HEAD would send — ahead of `origin/<base>` and not
 * on `origin/<branch>` — whose message carries a trailer, oldest first.
 */
export const commitsWithTrailer = async (
  deps: GitDeps,
  worktree: string,
  branch: string,
  base: string,
): Promise<TrailerCommit[]> => {
  const remoteBranch = `refs/remotes/origin/${branch}`;
  const pushed = await gitSucceeds(deps.exec, [
    '-C',
    worktree,
    'rev-parse',
    '--verify',
    '--quiet',
    remoteBranch,
  ]);
  const log = await gitOk(deps.exec, [
    '-C',
    worktree,
    'log',
    '--reverse',
    `--format=%H${FIELD}%s${FIELD}%B${RECORD}`,
    `refs/remotes/origin/${base}..HEAD`,
    ...(pushed ? [`^${remoteBranch}`] : []),
  ]);
  const held: TrailerCommit[] = [];
  for (const entry of log.split(RECORD)) {
    const [sha, subject, body] = entry.replace(/^\n/, '').split(FIELD);
    if (!sha || body === undefined) continue;
    if (hasClaudeTrailer(body)) held.push({ sha, subject: subject ?? '' });
  }
  return held;
};

/** "2 commits to rewrite" — the `hold_push` detail (D7), never a subject. */
export const heldDetail = (commits: readonly TrailerCommit[]): string =>
  `${commits.length} commit${commits.length === 1 ? '' : 's'} to rewrite`;

const listed = (commits: readonly TrailerCommit[]): string => {
  const shown = commits
    .slice(0, TRAILER_COMMITS_LISTED)
    .map((c) => `${c.sha.slice(0, 12)} "${c.subject.replace(/\s+/g, ' ')}"`);
  const more = commits.length - shown.length;
  return [...shown, ...(more > 0 ? [`and ${more} more`] : [])].join(', ');
};

/**
 * What the worker is told, typed into its session as one line: which
 * commits, and to rewrite them without pushing.
 */
export const trailerMessage = (commits: readonly TrailerCommit[]): string =>
  `AgentDock did not push this branch: ${commits.length === 1 ? 'this commit carries' : 'these commits carry'} a Claude attribution trailer (Co-Authored-By: Claude / Claude-Session: / Generated with Claude Code): ${listed(commits)}. Rewrite ${commits.length === 1 ? 'its message' : 'their messages'} without it, keeping the changes (git commit --amend for the newest; a non-interactive rebase for older ones), and do not push — AgentDock pushes once no commit carries one.`;

/**
 * `card.collect` with a held push: nothing was pushed and no pull request
 * opened. The message names the commits, so the API can show why.
 */
export class TrailerHeld extends CommandFailure {
  constructor(readonly commits: readonly TrailerCommit[]) {
    super(
      'invalid_args',
      `not pushed: ${heldDetail(commits)} — ${commits.length === 1 ? 'it carries' : 'they carry'} a Claude attribution trailer: ${listed(commits)}`.slice(
        0,
        1000,
      ),
    );
  }
}
