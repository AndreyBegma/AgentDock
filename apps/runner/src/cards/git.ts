import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import {
  AGENTDOCK_WORKTREE_DIR,
  CARD_PR_DESCRIPTION_FILE,
  CARD_PR_MARKER,
  cardWipCommitMessage,
} from '@agentdock/shared';
import type {
  CardCollectArgs,
  CardCollectPrState,
  CardCollectResult,
  CardRunFile,
} from '@agentdock/shared/protocol';
import { z } from 'zod';
import { CommandFailure } from '../commands/failure';
import {
  GH_TIMEOUT_MS,
  gitOk,
  gitSucceeds,
  NETWORK_TIMEOUT_MS,
  type SkillsDeps,
  stderrLine,
} from '../skills/deps';
import { createPullRequest, githubOf, pushBranch } from '../skills/run/collect';
import type { CardRecord } from './record';
import { commitsWithTrailer, TrailerHeld } from './trailer-guard';

export type GitDeps = Pick<SkillsDeps, 'exec' | 'tempRoot'>;

/**
 * #309 D9: adds `pattern` to the worktree's git exclude (`info/exclude`, which
 * git reads for every worktree of the repository) unless a line already has
 * it, so `git status` and `add -A` never see the runner's own files.
 */
export const excludeFromGit = async (
  deps: GitDeps,
  worktree: string,
  pattern: string,
): Promise<void> => {
  const path = (
    await gitOk(deps.exec, [
      '-C',
      worktree,
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'info/exclude',
    ])
  ).trim();
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (current.split('\n').some((line) => line.trim() === pattern)) return;
  mkdirSync(dirname(path), { recursive: true });
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  appendFileSync(path, `${separator}${pattern}\n`);
};

/** The commit of a ref, or null when it does not exist. */
export const commitOf = async (
  deps: GitDeps,
  root: string,
  ref: string,
): Promise<string | null> => {
  const result = await deps.exec('git', [
    '-C',
    root,
    'rev-parse',
    '--verify',
    '--quiet',
    `${ref}^{commit}`,
  ]);
  return result?.code === 0 ? result.stdout.trim() : null;
};

/** Best effort: an unreachable origin still works from what it last fetched. */
export const fetchRef = (deps: GitDeps, root: string, ref: string) =>
  deps.exec('git', ['-C', root, 'fetch', '--quiet', 'origin', ref], {
    timeoutMs: NETWORK_TIMEOUT_MS,
  });

/**
 * D5: the card's worktree, created when it is missing — on round 1, and on a
 * round after `card.close` removed it. The branch is the local one when it
 * survived, else `origin/<branch>` when it was pushed, else a new branch from
 * `origin/<base>` — #640 (ADR-0063): from `origin/<startFrom>` when given, a
 * dependency card's unmerged branch.
 */
export const ensureWorktree = async (
  deps: GitDeps,
  record: Pick<CardRecord, 'root' | 'worktree' | 'branch' | 'base'>,
  startFrom?: string,
): Promise<'existing' | 'created'> => {
  const { root, worktree, branch, base } = record;
  if (existsSync(worktree)) return 'existing';
  const from = startFrom ?? base;
  await fetchRef(deps, root, from);
  await fetchRef(deps, root, branch);
  if (await commitOf(deps, root, `refs/heads/${branch}`)) {
    await gitOk(deps.exec, [
      '-C',
      root,
      'worktree',
      'add',
      '--quiet',
      worktree,
      branch,
    ]);
    return 'created';
  }
  const start =
    (await commitOf(deps, root, `refs/remotes/origin/${branch}`)) ??
    (await commitOf(deps, root, `refs/remotes/origin/${from}`));
  if (!start) throw new Error(`origin/${from} does not exist`);
  await gitOk(deps.exec, [
    '-C',
    root,
    'worktree',
    'add',
    '--quiet',
    '--no-track',
    '-b',
    branch,
    worktree,
    start,
  ]);
  return 'created';
};

/** Whether origin has `refs/heads/<branch>` — asked, not read from a stale ref. */
const onOrigin = async (
  deps: GitDeps,
  root: string,
  branch: string,
): Promise<boolean> => {
  const listed = await deps.exec(
    'git',
    ['-C', root, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
    { timeoutMs: NETWORK_TIMEOUT_MS },
  );
  if (!listed || listed.code !== 0) {
    throw new Error(`git ls-remote failed: ${stderrLine(listed)}`);
  }
  return listed.stdout.trim().length > 0;
};

/**
 * #359 D8: the follow-up of a merged card — `branch`, new, from the updated
 * `origin/<base>`, in the card's existing worktree (a missing one is then
 * created on it by `ensureWorktree`). A branch that exists already, here or
 * on origin, is `already_exists`, unless the worktree is on it with nothing
 * pushed — a `card.run` retried after a timeout. Uncommitted changes are
 * never carried to the new branch: such a worktree is `invalid_args`.
 */
export const startFollowUpBranch = async (
  deps: GitDeps,
  record: Pick<CardRecord, 'root' | 'worktree' | 'branch' | 'base'>,
): Promise<void> => {
  const { root, worktree, branch, base } = record;
  const fetched = await fetchRef(deps, root, base);
  if (!fetched || fetched.code !== 0) {
    throw new Error(`git fetch origin ${base} failed: ${stderrLine(fetched)}`);
  }
  const remote = await onOrigin(deps, root, branch);
  const local = await commitOf(deps, root, `refs/heads/${branch}`);
  const exists = existsSync(worktree);
  if (exists && local && !remote) {
    const head = await deps.exec('git', [
      '-C',
      worktree,
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ]);
    if (head?.code === 0 && head.stdout.trim() === branch) return;
  }
  if (local || remote) {
    throw new CommandFailure(
      'already_exists',
      `branch ${branch} exists ${local ? 'on the runner' : 'on origin'}`,
    );
  }
  if (!exists) return;
  const status = await gitOk(deps.exec, [
    '-C',
    worktree,
    'status',
    '--porcelain',
    '--untracked-files=normal',
  ]);
  if (status.trim() !== '') {
    throw new CommandFailure(
      'invalid_args',
      `${worktree} has uncommitted changes; a follow-up branch starts clean`,
    );
  }
  await gitOk(deps.exec, [
    '-C',
    worktree,
    'switch',
    '--quiet',
    '--no-track',
    '-c',
    branch,
    `refs/remotes/origin/${base}`,
  ]);
};

const isWithin = (path: string, dir: string): boolean =>
  path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);

/**
 * D2: writes the card's `files` (its spec) into the worktree and commits them
 * as their own commit, without the project's hooks. A path into `.git`, or
 * one that leaves the worktree through a symlink, is refused. Files already
 * committed with the same content make no commit.
 */
export const commitFiles = async (
  deps: GitDeps,
  worktree: string,
  files: readonly CardRunFile[],
): Promise<boolean> => {
  if (files.length === 0) return false;
  const top = realpathSync(worktree);
  for (const file of files) {
    if (file.path.split('/')[0] === '.git') {
      throw new CommandFailure(
        'path_not_allowed',
        `${file.path} is inside .git`,
      );
    }
    const target = join(top, file.path);
    mkdirSync(dirname(target), { recursive: true });
    const parent = realpathSync(dirname(target));
    const link = existsSync(target) && lstatSync(target).isSymbolicLink();
    if (!isWithin(parent, top) || link) {
      throw new CommandFailure(
        'path_not_allowed',
        `${file.path} leaves the card's worktree`,
      );
    }
    writeFileSync(target, file.content, { mode: 0o644 });
  }
  const paths = files.map((f) => f.path);
  await gitOk(deps.exec, ['-C', top, 'add', '--', ...paths]);
  if (await gitSucceeds(deps.exec, ['-C', top, 'diff', '--cached', '--quiet']))
    return false;
  await gitOk(deps.exec, [
    '-C',
    top,
    'commit',
    '--quiet',
    '--no-verify',
    '-m',
    `docs: add ${paths.join(', ')}`,
  ]);
  return true;
};

const openPrSchema = z.array(
  z.object({
    number: z.number().int().positive(),
    url: z.string().min(1),
    isDraft: z.boolean().optional(),
  }),
);

export interface OpenPr {
  number: number;
  url: string;
  state: CardCollectPrState;
}

/** The open PR of `branch`, or null; throws when `gh` cannot answer. */
export const openPullRequest = async (
  deps: GitDeps,
  github: string,
  branch: string,
): Promise<OpenPr | null> => {
  const listed = await deps.exec(
    'gh',
    [
      'pr',
      'list',
      '--repo',
      github,
      '--head',
      branch,
      '--state',
      'open',
      '--json',
      'number,url,isDraft',
      '--limit',
      '1',
    ],
    { timeoutMs: GH_TIMEOUT_MS },
  );
  if (!listed || listed.code !== 0) {
    throw new Error(`gh pr list failed: ${stderrLine(listed)}`);
  }
  const parsed = openPrSchema.safeParse(JSON.parse(listed.stdout || '[]'));
  if (!parsed.success) throw new Error('gh pr list printed no PR list');
  const pr = parsed.data[0];
  if (!pr) return null;
  return {
    number: pr.number,
    url: pr.url,
    state: pr.isDraft ? 'draft' : 'open',
  };
};

/** GitHub refuses a PR body over 65 536 characters; room is left for the marker. */
const PR_DESCRIPTION_MAX_CHARS = 60_000;

/**
 * #359 D3: the worker's `.agentdock/pull-request.md`, or null when it is
 * missing, empty, not a regular file, or reached through a symlink — a link
 * could put any file the runner can read into a public PR.
 */
export const readPullRequestDescription = (worktree: string): string | null => {
  const path = join(worktree, CARD_PR_DESCRIPTION_FILE);
  try {
    if (!lstatSync(path).isFile()) return null;
    // `.agentdock` itself may not be a link either.
    const real = join(realpathSync(worktree), CARD_PR_DESCRIPTION_FILE);
    if (realpathSync(path) !== real) return null;
    const text = readFileSync(path, 'utf8').trim();
    if (!text) return null;
    return text.length > PR_DESCRIPTION_MAX_CHARS
      ? `${text.slice(0, PR_DESCRIPTION_MAX_CHARS - 1)}…`
      : text;
  } catch {
    return null;
  }
};

const isMarkerLine = (line: string): boolean =>
  line.trimStart().startsWith(`${CARD_PR_MARKER}:`);

/**
 * #359 D3: the worker's description, with the API's `AgentDock-Card:` line —
 * the one the API traces the PR by — as its only marker. A marker the worker
 * wrote is dropped, so a PR never names another card.
 */
export const pullRequestBodyOf = (
  description: string,
  apiBody: string,
): string => {
  const marker = apiBody.split('\n').find(isMarkerLine)?.trim();
  const text = description
    .split('\n')
    .filter((line) => !isMarkerLine(line))
    .join('\n')
    .trim();
  return marker ? `${text}\n\n${marker}\n` : `${text}\n`;
};

/**
 * #359 D3: without the worker's file, the API's body led by the links to the
 * spec (`.md`) and the design `card.run` committed on the branch — every
 * frame of it (`.html`, #441).
 */
export const fallbackPullRequestBody = (
  apiBody: string,
  github: string,
  branch: string,
  specFiles: readonly string[],
): string => {
  const url = (path: string) =>
    `https://github.com/${github}/blob/${branch.split('/').map(encodeURIComponent).join('/')}/${path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
  const link = (path: string) => `[${path}](${url(path)})`;
  const spec = specFiles.find((p) => p.endsWith('.md'));
  const design = specFiles.filter((p) => p.endsWith('.html'));
  const parts = [
    ...(spec ? [`Spec: ${link(spec)}`] : []),
    ...(design.length > 0
      ? [`approved design: ${design.map(link).join(', ')}`]
      : []),
  ];
  return parts.length > 0 ? `${parts.join(' · ')}\n\n${apiBody}` : apiBody;
};

/** `gh pr edit <n> --body-file`, the body in a private temporary file. */
export const editPullRequestBody = async (
  deps: GitDeps,
  github: string,
  number: number,
  body: string,
): Promise<void> => {
  const dir = mkdtempSync(join(deps.tempRoot ?? tmpdir(), 'agentdock-pr-'));
  try {
    const file = join(dir, 'body.md');
    writeFileSync(file, body, { mode: 0o600 });
    const edited = await deps.exec(
      'gh',
      ['pr', 'edit', String(number), '--repo', github, '--body-file', file],
      { timeoutMs: GH_TIMEOUT_MS },
    );
    if (!edited || edited.code !== 0) {
      throw new Error(`gh pr edit failed: ${stderrLine(edited)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** #359 D3: `gh pr ready <n>` — the draft leaves draft at collect. */
const markPullRequestReady = async (
  deps: GitDeps,
  github: string,
  number: number,
): Promise<void> => {
  const ready = await deps.exec(
    'gh',
    ['pr', 'ready', String(number), '--repo', github],
    { timeoutMs: GH_TIMEOUT_MS },
  );
  if (!ready || ready.code !== 0) {
    throw new Error(`gh pr ready failed: ${stderrLine(ready)}`);
  }
};

/** C-127: `.env*` except `.env.example`, `*.pem`, `id_*`, `*.key`. */
export const isSecretPath = (path: string): boolean => {
  const name = path.split('/').at(-1) ?? path;
  if (name.startsWith('.env')) return name !== '.env.example';
  return (
    name.endsWith('.pem') || name.endsWith('.key') || name.startsWith('id_')
  );
};

/** The paths in the index that differ from HEAD. */
const stagedFiles = async (deps: GitDeps, wt: string): Promise<string[]> =>
  (await gitOk(deps.exec, ['-C', wt, 'diff', '--cached', '--name-only', '-z']))
    .split('\0')
    .filter((path) => path !== '');

/**
 * D8: commit the leftovers, push, and open a PR into the base unless one is
 * open for the branch already — then it is only pushed. Nothing ahead of
 * `origin/<base>` is "No changes": nothing is pushed or opened. The checkout
 * must be on `branch` — a session that switched branches (#282 D3) is
 * `invalid_args`, so nothing is committed to a branch the API did not name.
 */
export const collectCard = async (
  deps: GitDeps,
  record: Pick<CardRecord, 'projectId' | 'root' | 'worktree' | 'branch'> &
    Partial<Pick<CardRecord, 'specFiles' | 'pushPr'>>,
  args: CardCollectArgs,
  options: { trailerGuard?: boolean; trackedOnly?: boolean } = {},
): Promise<CardCollectResult> => {
  const wt = record.worktree;
  const head = await deps.exec('git', [
    '-C',
    wt,
    'symbolic-ref',
    '--quiet',
    '--short',
    'HEAD',
  ]);
  const current = head?.code === 0 ? head.stdout.trim() : null;
  if (current !== record.branch) {
    throw new CommandFailure(
      'invalid_args',
      `${wt} is on ${current ?? 'a detached HEAD'}, not ${record.branch}`,
    );
  }
  // #359 D3: the description is the PR's body, never a commit — also in a
  // worktree from before `card.run` excluded `.agentdock/` on every round.
  await excludeFromGit(deps, wt, `${AGENTDOCK_WORKTREE_DIR}/`);
  // C-127: the person's own checkout holds files the card never wrote
  // (`.env.local`, scratch notes) — only tracked changes are staged there.
  await gitOk(deps.exec, ['-C', wt, 'add', options.trackedOnly ? '-u' : '-A']);
  let staged: string[] | undefined;
  if (options.trackedOnly) {
    staged = await stagedFiles(deps, wt);
    const secrets = staged.filter(isSecretPath);
    if (secrets.length > 0) {
      await gitOk(deps.exec, ['-C', wt, 'reset', '--quiet']);
      throw new CommandFailure(
        'invalid_args',
        `refusing to commit files that look like secrets: ${secrets.join(', ')}`,
      );
    }
  }
  if (
    !(await gitSucceeds(deps.exec, ['-C', wt, 'diff', '--cached', '--quiet']))
  ) {
    await gitOk(deps.exec, [
      '-C',
      wt,
      'commit',
      '--quiet',
      '--no-verify',
      '-m',
      cardWipCommitMessage(args.number),
    ]);
  }
  await fetchRef(deps, record.root, args.base);
  const ahead = Number(
    (
      await gitOk(deps.exec, [
        '-C',
        wt,
        'rev-list',
        '--count',
        `refs/remotes/origin/${args.base}..HEAD`,
      ])
    ).trim(),
  );
  const listed = staged ? { staged } : {};
  if (!(ahead > 0)) return { ahead: 0, pushed: false, ...listed };
  // #447 D7: a commit with a Claude trailer holds the push and the PR.
  if (options.trailerGuard) {
    const held = await commitsWithTrailer(deps, wt, record.branch, args.base);
    if (held.length > 0) throw new TrailerHeld(held);
  }
  const github = await githubOf(deps, {
    id: record.projectId,
    root: record.root,
  });
  await pushBranch(deps, wt, record.branch);
  // #359 D3: the worker's description is the body — of a new PR, and of an
  // open one, edited. Without it, a new PR gets the API's body with the spec
  // link, and an open one keeps its body.
  const description = readPullRequestDescription(wt);
  const body =
    description !== null
      ? pullRequestBodyOf(description, args.body)
      : fallbackPullRequestBody(
          args.body,
          github,
          record.branch,
          record.specFiles ?? [],
        );
  // #329 D3: an open PR is reported whether this collect opened it or not,
  // so the API fills a link it lost.
  const open = await openPullRequest(deps, github, record.branch);
  // #359 D1/D3: the draft this runner opened during the round leaves draft,
  // and its placeholder body is replaced even without the worker's file. A
  // draft somebody else opened is left as it is.
  const ours =
    open !== null &&
    record.pushPr?.opened === true &&
    record.pushPr.number === open.number;
  if (open && (description !== null || ours)) {
    await editPullRequestBody(deps, github, open.number, body);
  }
  if (open && ours && open.state === 'draft') {
    await markPullRequestReady(deps, github, open.number);
    open.state = 'open';
  }
  const pr: OpenPr = open ?? {
    ...(await createPullRequest(deps, {
      github,
      base: args.base,
      branch: record.branch,
      title: args.title,
      body,
    })),
    state: 'open',
  };
  return {
    ahead,
    pushed: true,
    prNumber: pr.number,
    prUrl: pr.url,
    prState: pr.state,
    ...listed,
  };
};

/**
 * #344: `card.collect` of a card with no worktree here — `card.close` removed
 * it on Accept, and the runner's record with it. The branch it kept (or
 * `origin/<branch>`, when it was pushed and deleted) is checked out in a
 * temporary worktree and collected as usual; the worktree goes afterwards,
 * and the local branch too once every commit of it is on origin.
 */
export const collectBranch = async (
  deps: GitDeps,
  card: Pick<CardRecord, 'projectId' | 'root' | 'branch'>,
  args: CardCollectArgs,
  options: { trailerGuard?: boolean } = {},
): Promise<CardCollectResult> => {
  const { root, branch } = card;
  await fetchRef(deps, root, branch);
  const local = await commitOf(deps, root, `refs/heads/${branch}`);
  const remote = local
    ? null
    : await commitOf(deps, root, `refs/remotes/origin/${branch}`);
  if (!local && !remote) {
    throw new CommandFailure(
      'not_found',
      `branch ${branch} is neither on the runner nor on origin`,
    );
  }
  const dir = mkdtempSync(
    join(deps.tempRoot ?? tmpdir(), 'agentdock-collect-'),
  );
  const worktree = join(dir, 'worktree');
  try {
    await gitOk(deps.exec, [
      '-C',
      root,
      'worktree',
      'add',
      '--quiet',
      ...(local
        ? [worktree, branch]
        : ['--no-track', '-b', branch, worktree, `origin/${branch}`]),
    ]);
    try {
      return await collectCard(deps, { ...card, worktree }, args, options);
    } finally {
      await removeCardWorktree(deps, { root, worktree, branch });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * Whether every commit of the local `branch` is pushed: it is contained in
 * `origin/<branch>`, or — the remote branch deleted after an auto-merge
 * (#359 D7) — its tip is the head this runner pushed (`pushedHead`).
 */
const branchIsPushed = async (
  deps: GitDeps,
  root: string,
  branch: string,
  local: string,
  pushedHead: string | undefined,
): Promise<boolean> => {
  if (pushedHead !== undefined && local === pushedHead) return true;
  await fetchRef(deps, root, branch);
  const remote = await commitOf(deps, root, `refs/remotes/origin/${branch}`);
  if (!remote) return false;
  return gitSucceeds(deps.exec, [
    '-C',
    root,
    'merge-base',
    '--is-ancestor',
    local,
    remote,
  ]);
};

/**
 * D10: removes the card's worktree, and its local branch only when every
 * commit of it is pushed (`branchIsPushed`) — unpushed work is never
 * deleted. #359 D8: the card's earlier branches, a follow-up ago, go by the
 * same rule, best effort: `branchDeleted` speaks of the current one.
 */
export const removeCardWorktree = async (
  deps: GitDeps,
  record: Pick<CardRecord, 'root' | 'worktree' | 'branch'> &
    Partial<Pick<CardRecord, 'pushedHead' | 'previousBranches'>>,
): Promise<{ worktreeRemoved: boolean; branchDeleted: boolean }> => {
  const { root, worktree, branch } = record;
  let worktreeRemoved = false;
  if (existsSync(worktree)) {
    await gitOk(deps.exec, [
      '-C',
      root,
      'worktree',
      'remove',
      '--force',
      worktree,
    ]);
    worktreeRemoved = true;
  }
  for (const earlier of record.previousBranches ?? []) {
    if (earlier.branch === branch) continue;
    const local = await commitOf(deps, root, `refs/heads/${earlier.branch}`);
    if (
      local &&
      (await branchIsPushed(
        deps,
        root,
        earlier.branch,
        local,
        earlier.pushedHead,
      ))
    ) {
      await deps.exec('git', [
        '-C',
        root,
        'branch',
        '--quiet',
        '-D',
        earlier.branch,
      ]);
    }
  }
  const local = await commitOf(deps, root, `refs/heads/${branch}`);
  if (
    !local ||
    !(await branchIsPushed(deps, root, branch, local, record.pushedHead))
  ) {
    return { worktreeRemoved, branchDeleted: false };
  }
  await gitOk(deps.exec, ['-C', root, 'branch', '--quiet', '-D', branch]);
  return { worktreeRemoved, branchDeleted: true };
};
