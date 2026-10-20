import type {
  WatchedProject,
  WorktreeCommit,
  WorktreeFile,
  WorktreeFileStatus,
  WorktreeStatusArgs,
  WorktreeStatusResult,
} from '@nautelle/shared/protocol';
import {
  WORKTREE_COMMIT_SUBJECT_MAX,
  WORKTREE_FILE_PATH_MAX,
  WORKTREE_STATUS_MAX_COMMITS,
  WORKTREE_STATUS_MAX_FILES,
} from '@nautelle/shared/protocol';
import { parseWorktreeList } from '../../collectors/worktrees/worktrees';
import { watchedProject } from '../../control/target';
import type { Exec } from '../../detect/exec';
import { resolveFleetProject } from '../../fleet/project';
import { slotOfWorktree } from '../../fleet/session-name';
import { CommandFailure } from '../failure';

export interface WorktreeStatusDeps {
  exec: Exec;
  watchedProjects: () => readonly WatchedProject[];
}

const SHA = /^[0-9a-f]{40,64}$/;

/** What `status --porcelain=v2 --branch -z` says about the working tree. */
export interface PorcelainStatus {
  head: string | null;
  branch: string | null;
  /** Tracked paths with uncommitted changes. */
  changed: number;
  /** Untracked paths, in git's order. */
  untracked: string[];
}

/**
 * Parses `git status --porcelain=v2 --branch -z`: `# branch.*` headers, `1`
 * (changed), `2` (renamed or copied — the next NUL field is the original
 * path), `u` (unmerged), `?` (untracked); `!` (ignored) is never asked for.
 */
export const parsePorcelainV2 = (stdout: string): PorcelainStatus => {
  const status: PorcelainStatus = {
    head: null,
    branch: null,
    changed: 0,
    untracked: [],
  };
  const fields = stdout.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.startsWith('# branch.oid ')) {
      const oid = field.slice('# branch.oid '.length);
      status.head = SHA.test(oid) ? oid : null;
    } else if (field.startsWith('# branch.head ')) {
      const head = field.slice('# branch.head '.length);
      status.branch = head === '(detached)' ? null : head;
    } else if (field.startsWith('1 ') || field.startsWith('u ')) {
      status.changed++;
    } else if (field.startsWith('2 ')) {
      status.changed++;
      i++;
    } else if (field.startsWith('? ')) {
      status.untracked.push(field.slice(2));
    }
  }
  return status;
};

const STATUS_LETTERS: Record<string, WorktreeFileStatus> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type_changed',
};

/**
 * Parses `git diff --name-status -z`: `X\0path\0`, or `R<score>\0old\0new\0`
 * for a rename or copy. Returns path → status, the new path for a rename.
 */
export const parseNameStatus = (
  stdout: string,
): Map<string, WorktreeFileStatus> => {
  const map = new Map<string, WorktreeFileStatus>();
  const fields = stdout.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const letter = fields[i].charAt(0);
    if (!letter) continue;
    const status = STATUS_LETTERS[letter] ?? 'modified';
    if (letter === 'R' || letter === 'C') {
      const path = fields[i + 2];
      i += 2;
      if (path) map.set(path, status);
    } else {
      const path = fields[i + 1];
      i += 1;
      if (path) map.set(path, status);
    }
  }
  return map;
};

/**
 * Parses `git diff --numstat -z`: `add\tdel\tpath\0`, or `add\tdel\t\0old\0new\0`
 * for a rename. A binary file shows `-` counts, returned as null.
 */
export const parseNumstat = (
  stdout: string,
): Map<string, { additions: number | null; deletions: number | null }> => {
  const map = new Map<
    string,
    { additions: number | null; deletions: number | null }
  >();
  const fields = stdout.split('\0');
  const count = (text: string | undefined): number | null =>
    text && /^\d+$/.test(text) ? Number(text) : null;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const [added, deleted, ...rest] = field.split('\t');
    let path = rest.join('\t');
    if (path === '') {
      path = fields[i + 2] ?? '';
      i += 2;
    }
    if (path) {
      map.set(path, { additions: count(added), deletions: count(deleted) });
    }
  }
  return map;
};

const UNIT = '\u001f';
const RECORD = '\u001e';
/** sha, subject, author name, committer date (strict ISO 8601). */
export const LOG_FORMAT = `%H${UNIT}%s${UNIT}%an${UNIT}%cI${RECORD}`;

/** Parses `git log --format=LOG_FORMAT`; a malformed record is skipped. */
export const parseLog = (stdout: string): WorktreeCommit[] => {
  const commits: WorktreeCommit[] = [];
  for (const record of stdout.split(RECORD)) {
    const [sha, subject, author, at] = record.trim().split(UNIT);
    if (!sha || !SHA.test(sha) || !at || Number.isNaN(Date.parse(at))) {
      continue;
    }
    commits.push({
      sha,
      subject: (subject ?? '').slice(0, WORKTREE_COMMIT_SUBJECT_MAX),
      author: (author ?? '').slice(0, 200),
      at,
    });
  }
  return commits.slice(0, WORKTREE_STATUS_MAX_COMMITS);
};

/** The `.wt-<repo>-<slot>` worktree git lists for the root, else `path_not_allowed`. */
const worktreeOf = async (
  exec: Exec,
  root: string,
  slot: string,
): Promise<string> => {
  const listed = await exec('git', [
    '-C',
    root,
    'worktree',
    'list',
    '--porcelain',
  ]);
  if (!listed || listed.code !== 0) {
    throw new CommandFailure(
      'not_a_repository',
      `cannot list the worktrees of ${root}`,
    );
  }
  for (const entry of parseWorktreeList(listed.stdout)) {
    if (entry.prunable) continue;
    if (slotOfWorktree(root, entry.path) === slot) return entry.path;
  }
  throw new CommandFailure(
    'path_not_allowed',
    `${slot} has no worktree in ${root}`,
  );
};

/**
 * `worktree.status`: a read-only look at a slot's worktree, resolved from the
 * slot within a watched root (never from a caller's path). Every git call is
 * a fixed argv; the base is a validated ref name, checked with `rev-parse
 * --verify` before it is used in a range.
 */
export const worktreeStatus = async (
  args: WorktreeStatusArgs,
  deps: WorktreeStatusDeps,
): Promise<WorktreeStatusResult> => {
  const project = watchedProject(args, deps.watchedProjects());
  const { exec } = deps;
  const cwd = await worktreeOf(exec, project.root, args.slot);
  const git = async (gitArgs: string[]): Promise<string | null> => {
    const result = await exec('git', ['-C', cwd, ...gitArgs]);
    return result && result.code === 0 ? result.stdout : null;
  };

  const porcelain = await git([
    'status',
    '--porcelain=v2',
    '--branch',
    '-z',
    '--untracked-files=all',
  ]);
  if (porcelain === null) {
    throw new CommandFailure(
      'not_a_repository',
      `cannot read the status of ${args.slot}`,
    );
  }
  const status = parsePorcelainV2(porcelain);

  const base = status.head ? await resolveBase(args, project, git, exec) : null;
  let ahead: number | null = null;
  let behind: number | null = null;
  let from: string | null = status.head ? 'HEAD' : null;
  if (base) {
    const counts = await git([
      'rev-list',
      '--left-right',
      '--count',
      `${base}...HEAD`,
    ]);
    const [b, a] = (counts ?? '').trim().split(/\s+/).map(Number);
    if (Number.isInteger(a) && Number.isInteger(b)) {
      ahead = a;
      behind = b;
    }
    const mergeBase = (await git(['merge-base', base, 'HEAD']))?.trim();
    if (mergeBase && SHA.test(mergeBase)) from = mergeBase;
  }

  const files: WorktreeFile[] = [];
  if (from) {
    const names = parseNameStatus(
      (await git(['diff', '--name-status', '-z', '-M', from, '--'])) ?? '',
    );
    const stats = parseNumstat(
      (await git(['diff', '--numstat', '-z', '-M', from, '--'])) ?? '',
    );
    for (const [path, fileStatus] of names) {
      const stat = stats.get(path);
      files.push({
        path: path.slice(0, WORKTREE_FILE_PATH_MAX),
        status: fileStatus,
        additions: stat?.additions ?? null,
        deletions: stat?.deletions ?? null,
      });
    }
  }
  for (const path of status.untracked) {
    files.push({
      path: path.slice(0, WORKTREE_FILE_PATH_MAX),
      status: 'untracked',
      additions: null,
      deletions: null,
    });
  }

  const log = status.head
    ? await git([
        'log',
        `-${WORKTREE_STATUS_MAX_COMMITS}`,
        `--format=${LOG_FORMAT}`,
        'HEAD',
        '--',
      ])
    : null;

  return {
    slot: args.slot,
    branch: status.branch,
    head: status.head,
    base,
    ahead,
    behind,
    changed: status.changed,
    untracked: status.untracked.length,
    files: files.slice(0, WORKTREE_STATUS_MAX_FILES),
    filesTruncated: Math.max(0, files.length - WORKTREE_STATUS_MAX_FILES),
    commits: log ? parseLog(log) : [],
  };
};

/** `origin/<base>`, else `<base>`, else the project's default branch — the first that resolves. */
const resolveBase = async (
  args: WorktreeStatusArgs,
  project: WatchedProject,
  git: (gitArgs: string[]) => Promise<string | null>,
  exec: Exec,
): Promise<string | null> => {
  const resolves = async (ref: string): Promise<boolean> =>
    Boolean(
      (
        await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
      )?.trim(),
    );
  for (const ref of args.base ? [`origin/${args.base}`, args.base] : []) {
    if (await resolves(ref)) return ref;
  }
  const { defaultBase } = await resolveFleetProject(exec, project);
  return defaultBase && (await resolves(defaultBase)) ? defaultBase : null;
};
