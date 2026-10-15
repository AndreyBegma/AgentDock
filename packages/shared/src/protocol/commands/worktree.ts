import { z } from 'zod';
import type { CommandDefinition } from '../commands';
import { absolutePathSchema } from '../projects';
import { slotNameSchema } from './control';
import { gitRefSchema } from './skills';

/**
 * `worktree.status` (docs/specs/160-agent-workspace.md): a read-only look at
 * one slot's worktree — branch, ahead / behind its base, the working tree's
 * changed and untracked counts, the files that differ from the base with
 * their line counts, and the last commits.
 *
 * The worktree is never named by the caller: the runner resolves it from the
 * slot within the watched `root` (the `.wt-<repo>-<slot>` worktree git lists
 * for that root), as `slot.stop` does (spec 17 D6), and `root` itself must be
 * an entry of the watch list. There is no path, ref range or git argument
 * field; an unknown field fails to parse (ADR-0010).
 */

/** Resolving the worktree and five read-only git calls. */
export const WORKTREE_STATUS_TIMEOUT_MS = 10_000;
/** Files listed in `files`; the rest is counted in `filesTruncated`. */
export const WORKTREE_STATUS_MAX_FILES = 200;
/** Commits listed in `commits`, newest first. */
export const WORKTREE_STATUS_MAX_COMMITS = 5;
/** A commit subject is cut to this many characters. */
export const WORKTREE_COMMIT_SUBJECT_MAX = 200;
/** A file path is cut to this many characters. */
export const WORKTREE_FILE_PATH_MAX = 1024;

export const worktreeStatusArgsSchema = z.strictObject({
  projectId: z.string().min(1),
  root: absolutePathSchema,
  slot: slotNameSchema,
  /**
   * The branch ahead / behind and the file diff are counted against:
   * `origin/<base>`, else `<base>`. Absent, or neither resolving: the
   * project's default branch.
   */
  base: gitRefSchema.optional(),
});
export type WorktreeStatusArgs = z.infer<typeof worktreeStatusArgsSchema>;

/**
 * How a file differs from the base (`A`dded, `M`odified, `D`eleted,
 * `R`enamed, `C`opied, `T`ype changed), or `untracked`.
 */
export const WORKTREE_FILE_STATUSES = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'type_changed',
  'untracked',
] as const;
export const worktreeFileStatusSchema = z.enum(WORKTREE_FILE_STATUSES);
export type WorktreeFileStatus = z.infer<typeof worktreeFileStatusSchema>;

const count = z.number().int().nonnegative();

export const worktreeFileSchema = z.object({
  /** Relative to the worktree, `/`-separated; a rename names the new path. */
  path: z.string().min(1).max(WORKTREE_FILE_PATH_MAX),
  status: worktreeFileStatusSchema,
  /** Lines added; null for a binary file or an untracked one. */
  additions: count.nullable(),
  deletions: count.nullable(),
});
export type WorktreeFile = z.infer<typeof worktreeFileSchema>;

export const worktreeCommitSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40,64}$/),
  subject: z.string().max(WORKTREE_COMMIT_SUBJECT_MAX),
  author: z.string().max(200),
  at: z.iso.datetime({ offset: true }),
});
export type WorktreeCommit = z.infer<typeof worktreeCommitSchema>;

export const worktreeStatusResultSchema = z.object({
  slot: slotNameSchema,
  /** The checked-out branch; null on a detached HEAD. */
  branch: z.string().min(1).nullable(),
  /** The HEAD commit; null in a repository without commits. */
  head: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/)
    .nullable(),
  /** The ref counted against, as resolved (`origin/develop`); null when none resolved. */
  base: z.string().min(1).nullable(),
  /** Commits on HEAD not on the base; null without a base. */
  ahead: count.nullable(),
  behind: count.nullable(),
  /** Tracked files with uncommitted changes, staged or not. */
  changed: count,
  /** Files git does not track and does not ignore. */
  untracked: count,
  /**
   * The files that differ from the merge base — committed, staged and
   * unstaged — then the untracked ones; at most `WORKTREE_STATUS_MAX_FILES`.
   * Without a base, only the uncommitted changes against HEAD.
   */
  files: z.array(worktreeFileSchema).max(WORKTREE_STATUS_MAX_FILES),
  /** Files left out of `files`. */
  filesTruncated: count,
  /** Newest first, at most `WORKTREE_STATUS_MAX_COMMITS`. */
  commits: z.array(worktreeCommitSchema).max(WORKTREE_STATUS_MAX_COMMITS),
});
export type WorktreeStatusResult = z.infer<typeof worktreeStatusResultSchema>;

/**
 * Defined and exported here, and entered in the `commands` allowlist together
 * with its runner handler (the runner's `CommandHandlers` needs one per key).
 */
export const worktreeCommands = {
  'worktree.status': {
    args: worktreeStatusArgsSchema,
    result: worktreeStatusResultSchema,
    minRole: 'viewer',
    timeoutMs: WORKTREE_STATUS_TIMEOUT_MS,
  },
} as const satisfies Record<string, CommandDefinition>;
