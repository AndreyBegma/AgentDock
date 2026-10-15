import { z } from 'zod';
import {
  ATTACHMENTS_PER_CARD_MAX,
  attachmentRefSchema,
} from '../../attachments';
import type { CommandDefinition } from '../commands';
import { absolutePathSchema } from '../projects';
import { headShaSchema } from './approvals';
import {
  orchestratorModelSchema,
  orchestratorPermissionModeSchema,
} from './control';
import {
  gitRefSchema,
  profileKeySchema,
  skillFilePathSchema,
  skillRunIdSchema,
} from './skills';

/**
 * Board card workers (issue #242 "Runner", ADR-0024). A card's worker is an
 * interactive Claude Code session in its own worktree and tmux session,
 * outside the orchestrator.
 *
 * `cardCommands` is defined and exported here, but entered in the `commands`
 * allowlist only together with its runner handlers: the runner's
 * `CommandHandlers` needs a handler for every key of that map, so an entry
 * without one breaks the runner build (as spec 24 and spec 29 did).
 *
 * No argument is a path the runner trusts as given: `root` is checked against
 * the watched project, the worktree and session names are derived from
 * `shortId`, and `files` are repository-relative.
 */

/** Per-command timeouts. Run creates the worktree on round 1; collect pushes and opens a PR. */
export const CARD_TIMEOUTS_MS = {
  run: 60_000,
  stop: 15_000,
  collect: 180_000,
  close: 30_000,
  /** #273: `gh pr view`, `gh pr merge`, then the issue. */
  merge: 90_000,
} as const;

/** `card.run` prompt: one argv element read from `launch.json`, never a shell string (D5). */
export const CARD_RUN_PROMPT_MAX_BYTES = 64 * 1024;
/** Files `card.run` commits as the branch's first commit (the D2 spec). */
export const CARD_RUN_FILES_MAX = 4;
export const CARD_RUN_FILE_MAX_BYTES = 192 * 1024;
/** `card.collect` PR body. */
export const CARD_COLLECT_BODY_MAX_BYTES = 16 * 1024;

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

const noNul = (t: string): boolean => !t.includes('\u0000');

/** A `board_cards.id`: a plain token, never a path. */
export const cardIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'must match ^[A-Za-z0-9_-]{1,64}$');

/** D5: the short id a card's worktree, tmux session and runner record share. */
export const cardShortIdSchema = z
  .string()
  .regex(/^[a-z0-9]{8}$/, 'must match ^[a-z0-9]{8}$');

/** D5: the card's tmux session. Never `cs-` — `watch.sh` treats those as slots. */
export const CARD_SESSION_PREFIX = 'agentdock-card-';

export const cardTmuxSessionSchema = z
  .string()
  .regex(/^agentdock-card-[a-z0-9]{8}$/, 'must be agentdock-card-<shortid>');

export const cardSessionName = (shortId: string): string =>
  CARD_SESSION_PREFIX + cardShortIdSchema.parse(shortId);

/** D5/D6: the Claude session; the API fixes the uuid at the first Run. */
export const cardSessionSchema = z.strictObject({
  id: z.uuid(),
  /** `claude --resume <id>` when true, `claude --session-id <id>` when false. */
  resume: z.boolean(),
});
export type CardSession = z.infer<typeof cardSessionSchema>;

export const cardPromptSchema = z
  .string()
  .min(1)
  .refine(noNul, { message: 'must not contain NUL' })
  .refine((t) => utf8Bytes(t) <= CARD_RUN_PROMPT_MAX_BYTES, {
    message: `must be at most ${CARD_RUN_PROMPT_MAX_BYTES} bytes`,
  });

/** A file the runner writes and commits before the worker starts (D2). */
export const cardRunFileSchema = z.strictObject({
  path: skillFilePathSchema,
  content: z
    .string()
    .refine(noNul, { message: 'must not contain NUL' })
    .refine((t) => utf8Bytes(t) <= CARD_RUN_FILE_MAX_BYTES, {
      message: `must be at most ${CARD_RUN_FILE_MAX_BYTES} bytes`,
    }),
});
export type CardRunFile = z.infer<typeof cardRunFileSchema>;

const cardTarget = {
  cardId: cardIdSchema,
  projectId: z.string().min(1),
};

// card.run

/**
 * D5. Round 1 (`session.resume: false`) creates the worktree
 * `<parent>/.wt-<repo>-card-<shortId>` from `origin/<base>` on `branch` — or
 * checks out `origin/<branch>` when it exists — commits `files`, then starts
 * tmux `agentdock-card-<shortId>` running `exec-run` with `interactive: true`.
 * A later round reuses the worktree and resumes the session. The round
 * outlives this command: progress arrives as `card_run.*` events.
 *
 * #309 D9: before it launches or resumes the session, the runner makes
 * `<worktree>/.agentdock/attachments/` hold exactly `attachments` — each
 * missing file downloaded from `runnerAttachmentPath(id)`, its size and
 * SHA-256 checked, written atomically as `attachmentFileName(id, name)`;
 * unlisted files removed; `.agentdock/` git-excluded. Absent is an empty
 * list. A download or check that fails fails the command with
 * `attachments_unavailable`.
 */
export const cardRunArgsSchema = z
  .strictObject({
    ...cardTarget,
    runId: skillRunIdSchema,
    root: absolutePathSchema,
    base: gitRefSchema,
    shortId: cardShortIdSchema,
    branch: gitRefSchema,
    session: cardSessionSchema,
    prompt: cardPromptSchema,
    files: z.array(cardRunFileSchema).max(CARD_RUN_FILES_MAX).optional(),
    /** #309 D9: every attachment of the card and its rounds, in upload order. */
    attachments: z
      .array(attachmentRefSchema)
      .max(ATTACHMENTS_PER_CARD_MAX)
      .optional(),
    profileKey: profileKeySchema,
    model: orchestratorModelSchema,
    permissionMode: orchestratorPermissionModeSchema,
  })
  .refine(
    (a) =>
      new Set((a.files ?? []).map((f) => f.path)).size ===
      (a.files ?? []).length,
    { message: 'file paths must be distinct', path: ['files'] },
  )
  .refine(
    (a) =>
      new Set((a.attachments ?? []).map((f) => f.id)).size ===
      (a.attachments ?? []).length,
    { message: 'attachment ids must be distinct', path: ['attachments'] },
  );
export type CardRunArgs = z.infer<typeof cardRunArgsSchema>;

export const cardRunResultSchema = z.object({
  phase: z.enum(['starting', 'running']),
  tmuxSession: cardTmuxSessionSchema,
});
export type CardRunResult = z.infer<typeof cardRunResultSchema>;

// card.stop

/** Kills the card's tmux session; `stopped: false` when none was alive. */
export const cardStopArgsSchema = z.strictObject(cardTarget);
export type CardStopArgs = z.infer<typeof cardStopArgsSchema>;

export const cardStopResultSchema = z.object({ stopped: z.boolean() });
export type CardStopResult = z.infer<typeof cardStopResultSchema>;

// card.collect

/**
 * D8: commit leftovers (`chore: card C-<number> work in progress`), push, and
 * open a PR into `base` when none is open for `branch` (else push only).
 */
export const cardCollectArgsSchema = z.strictObject({
  ...cardTarget,
  root: absolutePathSchema,
  base: gitRefSchema,
  branch: gitRefSchema,
  /** The card's per-project number, for the leftovers commit message. */
  number: z.number().int().positive(),
  title: z
    .string()
    .min(1)
    .max(256)
    .refine((t) => !/[\r\n]/.test(t), { message: 'must be one line' }),
  body: z
    .string()
    .refine(noNul, { message: 'must not contain NUL' })
    .refine((t) => utf8Bytes(t) <= CARD_COLLECT_BODY_MAX_BYTES, {
      message: `must be at most ${CARD_COLLECT_BODY_MAX_BYTES} bytes`,
    }),
});
export type CardCollectArgs = z.infer<typeof cardCollectArgsSchema>;

export const cardCollectResultSchema = z
  .object({
    /** Commits on the branch ahead of `origin/<base>`; `0` is "No changes". */
    ahead: z.number().int().nonnegative(),
    pushed: z.boolean(),
    /** The open PR of the branch, new or existing. */
    prNumber: z.number().int().positive().optional(),
    prUrl: z.url({ protocol: /^https$/ }).optional(),
  })
  .refine((r) => (r.prNumber === undefined) === (r.prUrl === undefined), {
    message: 'prNumber and prUrl go together',
    path: ['prUrl'],
  });
export type CardCollectResult = z.infer<typeof cardCollectResultSchema>;

// card.close

/**
 * D10: kill tmux; with `removeWorktree`, remove the worktree and delete the
 * local branch only when it is pushed. Never merges anything.
 */
export const cardCloseArgsSchema = z.strictObject({
  ...cardTarget,
  removeWorktree: z.boolean(),
});
export type CardCloseArgs = z.infer<typeof cardCloseArgsSchema>;

export const cardCloseResultSchema = z.object({
  stopped: z.boolean(),
  worktreeRemoved: z.boolean(),
  branchDeleted: z.boolean(),
});
export type CardCloseResult = z.infer<typeof cardCloseResultSchema>;

// card.merge

/** #273 D13: the issue comment `card.merge` closes the issue with, in UTF-8 bytes. */
export const CARD_MERGE_COMMENT_MAX_BYTES = 1024;

/** #273 D12: `gh pr merge --<method>`. */
export const cardMergeMethodSchema = z.enum(['merge', 'squash', 'rebase']);
export type CardMergeMethod = z.infer<typeof cardMergeMethodSchema>;

/**
 * #273 D11, D13 (ADR-0029): a person's Accept merges the card's PR through
 * the runner's `gh`, in the project root — `gh pr merge <pr> --<method>
 * --match-head-commit <headSha>`, never a command text — then closes `issue`
 * with `comment` when it is still open (`Closes #n` does nothing on a
 * non-default base). `method: null` takes the repository's first allowed
 * method, merge → squash → rebase. Never deletes the branch (D15).
 */
export const cardMergeArgsSchema = z.strictObject({
  ...cardTarget,
  root: absolutePathSchema,
  pr: z.number().int().positive(),
  /** The head the person saw; the merge is refused for any other. */
  headSha: headShaSchema,
  method: cardMergeMethodSchema.nullable(),
  issue: z.number().int().positive().nullable(),
  comment: z
    .string()
    .min(1)
    .refine(noNul, { message: 'must not contain NUL' })
    .refine((t) => utf8Bytes(t) <= CARD_MERGE_COMMENT_MAX_BYTES, {
      message: `must be at most ${CARD_MERGE_COMMENT_MAX_BYTES} bytes`,
    }),
});
export type CardMergeArgs = z.infer<typeof cardMergeArgsSchema>;

/** The PR is merged — now, or before (`alreadyMerged`). */
export const cardMergeSuccessSchema = z.object({
  merged: z.literal(true),
  alreadyMerged: z.boolean(),
  /** The method used; for an already merged PR, the one asked or resolved. */
  method: cardMergeMethodSchema,
  mergeCommit: headShaSchema.nullable(),
  issueClosed: z.boolean(),
  /** One line: why closing the issue failed. */
  issueError: z.string().max(500).optional(),
});
export type CardMergeSuccess = z.infer<typeof cardMergeSuccessSchema>;

/** #273 D13: why the merge was refused; the API answers 409 `merge_failed` with it as `reason`. */
export const cardMergeFailReasonSchema = z.enum([
  'head_changed',
  'not_mergeable',
  'closed',
  'gh_failed',
]);
export type CardMergeFailReason = z.infer<typeof cardMergeFailReasonSchema>;

/**
 * A refused merge is a result, not a command error: nothing was merged and
 * the API keeps the card in Finished. `message` is the runner's one line.
 */
export const cardMergeFailureSchema = z.object({
  merged: z.literal(false),
  error: cardMergeFailReasonSchema,
  message: z.string().max(500),
});
export type CardMergeFailure = z.infer<typeof cardMergeFailureSchema>;

export const cardMergeResultSchema = z.discriminatedUnion('merged', [
  cardMergeSuccessSchema,
  cardMergeFailureSchema,
]);
export type CardMergeResult = z.infer<typeof cardMergeResultSchema>;

/** The card commands; every one needs an operator (D11). */
export const cardCommands = {
  'card.run': {
    args: cardRunArgsSchema,
    result: cardRunResultSchema,
    minRole: 'operator',
    timeoutMs: CARD_TIMEOUTS_MS.run,
  },
  'card.stop': {
    args: cardStopArgsSchema,
    result: cardStopResultSchema,
    minRole: 'operator',
    timeoutMs: CARD_TIMEOUTS_MS.stop,
  },
  'card.collect': {
    args: cardCollectArgsSchema,
    result: cardCollectResultSchema,
    minRole: 'operator',
    timeoutMs: CARD_TIMEOUTS_MS.collect,
  },
  'card.close': {
    args: cardCloseArgsSchema,
    result: cardCloseResultSchema,
    minRole: 'operator',
    timeoutMs: CARD_TIMEOUTS_MS.close,
  },
  'card.merge': {
    args: cardMergeArgsSchema,
    result: cardMergeResultSchema,
    minRole: 'operator',
    timeoutMs: CARD_TIMEOUTS_MS.merge,
  },
} as const satisfies Record<string, CommandDefinition>;

export type CardCommandName = keyof typeof cardCommands;
