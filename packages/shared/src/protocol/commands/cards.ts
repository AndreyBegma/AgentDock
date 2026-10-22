import { z } from 'zod';
import { CARD_EFFORTS } from '../../assess/limits';
import {
  ATTACHMENTS_PER_CARD_MAX,
  attachmentRefSchema,
} from '../../attachments';
import { cardPrefixSchema } from '../../prefix/contracts';
import { techniqueFlagsSchema } from '../../token-economy/techniques';
import { tokenSaverConfigSchema } from '../../token-saver/contracts';
import type { CommandDefinition } from '../commands';
import {
  cardBranchSchema,
  hasCardBranchPrefix,
  protectedPathsSchema,
} from '../branch-policy';
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
  /** #329 D8: `gh pr close`, the branch, then the issue. */
  prClose: 60_000,
  /** #359 D5: `gh pr view` and `gh pr checks`. */
  checks: 30_000,
  /** #484: `gh pr view`, `gh pr close`, then `gh pr reopen`. */
  ciRetrigger: 45_000,
  /** #636: `gh pr view`, then `gh pr edit --base`. */
  prRetarget: 45_000,
  /** #709: `gh pr list`, `gh pr create`, then `gh pr view`. */
  prOpen: 60_000,
} as const;

/** `card.run` prompt: one argv element read from `launch.json`, never a shell string (D5). */
export const CARD_RUN_PROMPT_MAX_BYTES = 64 * 1024;
/**
 * Files `card.run` commits as the branch's first commit: the D2 spec and
 * every frame of the approved design (#441). A frame is at most
 * `DESIGN_HTML_MAX_BYTES` (#686), so this bounds the command, not the frames.
 */
export const CARD_RUN_FILES_MAX = 256;
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
export const CARD_SESSION_PREFIX = 'nautelle-card-';

/** A session started before the rename keeps its `agentdock-` name (ADR-0073). */
export const cardTmuxSessionSchema = z
  .string()
  .regex(
    /^(?:nautelle|agentdock)-card-[a-z0-9]{8}$/,
    'must be nautelle-card-<shortid>',
  );

export const cardSessionName = (shortId: string): string =>
  CARD_SESSION_PREFIX + cardShortIdSchema.parse(shortId);

/** D5/D6: the Claude session; the API fixes the uuid at the first Run. */
export const cardSessionSchema = z.strictObject({
  id: z.uuid(),
  /** `claude --resume <id>` when true, `claude --session-id <id>` when false. */
  resume: z.boolean(),
  /**
   * #750 D7 (ADR-0076): a later round whose model or effort differs from the
   * pair this session was started with — the runner starts a fresh session
   * seeded from the handoff (ADR-0042 `fresh`), never `--resume` with another
   * `--model` or `--effort`. Needs `resume: true`. Sent only to a runner that
   * advertises `cardFreshStart`.
   */
  fresh: z.boolean().optional(),
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

/** A PR title: one line, as `gh pr create --title` takes it. */
const prTitleSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((t) => !/[\r\n]/.test(t), { message: 'must be one line' });

/** A PR body, at most `CARD_COLLECT_BODY_MAX_BYTES`. */
const prBodySchema = z
  .string()
  .refine(noNul, { message: 'must not contain NUL' })
  .refine((t) => utf8Bytes(t) <= CARD_COLLECT_BODY_MAX_BYTES, {
    message: `must be at most ${CARD_COLLECT_BODY_MAX_BYTES} bytes`,
  });

/**
 * #359 D1: the draft PR the runner opens during the round, once the
 * worktree's HEAD is ahead of `origin/<base>` — `gh pr create --draft` with
 * this title (`C-<n>: <title>`) and body (the spec link and the card summary,
 * shared `cardDraftPullRequestBody`). The worker's description replaces the
 * body at collect (D3).
 */
export const cardDraftPullRequestSchema = z.strictObject({
  title: prTitleSchema,
  body: prBodySchema,
});
export type CardDraftPullRequest = z.infer<typeof cardDraftPullRequestSchema>;

// card.run

/**
 * D5. Round 1 (`session.resume: false`) creates the worktree
 * `<parent>/.wt-<repo>-card-<shortId>` from `origin/<base>` on `branch` — or
 * checks out `origin/<branch>` when it exists — commits `files`, then starts
 * tmux `nautelle-card-<shortId>` running `exec-run` with `interactive: true`.
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
 *
 * #359 D1: with `pullRequest`, the runner's session poll pushes the committed
 * HEAD of `branch` (never the index or the working tree, at most once per
 * `CARD_PUSH_MIN_INTERVAL_MS`) and, when no PR is open for it, opens a draft
 * one; each push is reported as `card_run.pushed`. Absent: nothing is pushed
 * before collect.
 *
 * #359 D8: with `newBranch` (a later round only), the runner fetches `base`
 * and creates `branch` from the updated `origin/<base>` in the card's
 * existing worktree before it resumes the session — the follow-up of a
 * merged card. `branch` must not exist yet, locally or on the remote.
 *
 * Both are taken by a runner that advertises `card.checks` (the same
 * release); an older one refuses them as `invalid_args`, so the API sends
 * them only to a runner that advertises it.
 */
/**
 * #746 D11: a card launch's Token saver — the project's setting plus the
 * technique flags of the card's arms, `{ [technique]: on }`. `techniques` is
 * sent only to a runner that advertises `tokenEconomy`; it is strict over the
 * registered techniques, so an unknown key is refused.
 */
export const cardTokenSaverSchema = tokenSaverConfigSchema.extend({
  techniques: techniqueFlagsSchema.optional(),
  /** #751: the session's frozen prefix; only to a runner with `prefixOverlays`. */
  prefix: cardPrefixSchema.optional(),
});
export type CardTokenSaver = z.infer<typeof cardTokenSaverSchema>;

export const cardRunArgsSchema = z
  .strictObject({
    ...cardTarget,
    runId: skillRunIdSchema,
    root: absolutePathSchema,
    base: gitRefSchema,
    shortId: cardShortIdSchema,
    /** C-148: `card/`, `feat/` or `fix/` — never the default branch by name. */
    branch: cardBranchSchema,
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
    /**
     * #663: the CLI's `--effort`; absent is the CLI's own default. Sent only
     * to a runner that advertises `cardEffort` (a strict older one refuses it).
     */
    effort: z.enum(CARD_EFFORTS).optional(),
    permissionMode: orchestratorPermissionModeSchema,
    /** #359 D1: push during the round and open this draft PR. */
    pullRequest: cardDraftPullRequestSchema.optional(),
    /** #359 D8: create `branch` from the updated `origin/<base>` first. */
    newBranch: z.boolean().optional(),
    /** #445 D11: the project's Token saver; absent is off (a runner without the `tokenSaver` capability refuses it). */
    tokenSaver: cardTokenSaverSchema.optional(),
    /**
     * #750 D8: offer the worker `escalate_card` — a non-Opus round in the B
     * arm of `model-by-type` on a card that has not escalated yet. Sent only
     * to a runner that advertises `cardEscalate`.
     */
    escalate: z.literal(true).optional(),
  })
  .refine(
    (a) =>
      new Set((a.files ?? []).map((f) => f.path)).size ===
      (a.files ?? []).length,
    { message: 'file paths must be distinct', path: ['files'] },
  )
  .refine((a) => a.newBranch !== true || a.session.resume, {
    message: 'newBranch needs a resumed session',
    path: ['newBranch'],
  })
  .refine((a) => a.session.fresh !== true || a.session.resume, {
    message: 'a fresh start needs a later round',
    path: ['session', 'fresh'],
  })
  .refine((a) => a.pullRequest === undefined || a.branch !== a.base, {
    message: 'a pushed branch must not be the base branch',
    path: ['branch'],
  })
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
 *
 * #282 D3: with `cwd`, a `terminal` card collects its tracked session's work
 * instead of a card worktree. The runner takes `cwd` only inside `root` or
 * one of the worktrees git lists for it (else `path_not_allowed`), collects
 * in the checkout that holds it, and only when that checkout is on `branch`
 * (else `invalid_args`). `branch` is never `base`: the base is not committed
 * to or pushed.
 *
 * C-148: a card worktree's `branch` has a card prefix (`cardBranchSchema`); a
 * terminal card's is its session's own, so only the runner's push guard
 * (never the default or a protected branch) applies to it.
 */
export const cardCollectArgsSchema = z
  .strictObject({
    ...cardTarget,
    root: absolutePathSchema,
    base: gitRefSchema,
    branch: gitRefSchema,
    /** #282 D3: the tracked session's cwd; absent for a card worktree. */
    cwd: absolutePathSchema.optional(),
    /** The card's per-project number, for the leftovers commit message. */
    number: z.number().int().positive(),
    title: prTitleSchema,
    body: prBodySchema,
  })
  .refine((a) => a.branch !== a.base, {
    message: 'must not be the base branch',
    path: ['branch'],
  })
  .refine((a) => a.cwd !== undefined || hasCardBranchPrefix(a.branch), {
    message: 'a card branch must start with card/, feat/ or fix/',
    path: ['branch'],
  });
export type CardCollectArgs = z.infer<typeof cardCollectArgsSchema>;

/** #329 D6: the open PR's state as `card.collect` saw it. */
export const cardCollectPrStateSchema = z.enum(['open', 'draft']);
export type CardCollectPrState = z.infer<typeof cardCollectPrStateSchema>;

export const cardCollectResultSchema = z
  .object({
    /** Commits on the branch ahead of `origin/<base>`; `0` is "No changes". */
    ahead: z.number().int().nonnegative(),
    pushed: z.boolean(),
    /**
     * The open PR of the branch, new or existing. #329 D3: always reported
     * when one is open — also when this collect did not open it, so the API
     * fills a lost `prUrl`.
     */
    prNumber: z.number().int().positive().optional(),
    prUrl: z.url({ protocol: /^https$/ }).optional(),
    /**
     * #329 D6: with a PR only. Absent — a runner older than the field — is
     * read as `open`.
     */
    prState: cardCollectPrStateSchema.optional(),
    /**
     * C-127: the files a terminal card's collect committed (its own checkout
     * stages tracked changes only). Absent for a worktree collect.
     */
    staged: z.array(z.string()).optional(),
    /**
     * C-148 (D-12): the protected paths the pushed branch changes against
     * `origin/<base>` (`isProtectedPath`); empty when none. Absent when
     * nothing was pushed, or from a runner older than the field.
     */
    protectedPaths: protectedPathsSchema.optional(),
  })
  .refine((r) => (r.prNumber === undefined) === (r.prUrl === undefined), {
    message: 'prNumber and prUrl go together',
    path: ['prUrl'],
  })
  .refine((r) => r.prState === undefined || r.prNumber !== undefined, {
    message: 'prState needs a PR',
    path: ['prState'],
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
 * method, merge → squash → rebase.
 *
 * #329 D7: with `deleteBranch`, after the PR is merged — now or before — the
 * runner deletes the PR's head branch on GitHub (`gh api -X DELETE
 * repos/<o>/<r>/git/refs/heads/<head>`), the head read from the PR itself;
 * never the base, never any other branch. Absent is `false` (D15: an API
 * older than the arg). A runner that advertises `card.prClose` takes this arg
 * (they ship in the same release, D9); an older one refuses it as
 * `invalid_args`, so the API sends it only to a runner that advertises
 * `card.prClose`.
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
  /** #329 D7: delete the PR's head branch on GitHub after the merge. */
  deleteBranch: z.boolean().optional(),
});
export type CardMergeArgs = z.infer<typeof cardMergeArgsSchema>;

/** #329 D7/D8: the one line of a failed step, as results carry it. */
const stepErrorSchema = z.string().max(500);

/** The PR is merged — now, or before (`alreadyMerged`). */
export const cardMergeSuccessSchema = z.object({
  merged: z.literal(true),
  alreadyMerged: z.boolean(),
  /** The method used; for an already merged PR, the one asked or resolved. */
  method: cardMergeMethodSchema,
  mergeCommit: headShaSchema.nullable(),
  issueClosed: z.boolean(),
  /** One line: why closing the issue failed. */
  issueError: stepErrorSchema.optional(),
  /**
   * #329 D7: the head branch was deleted. `false` when not asked, or the
   * deletion failed (`branchError`) — which never undoes the merge. Absent —
   * a runner older than the field — is `false`.
   */
  branchDeleted: z.boolean().default(false),
  /** One line: why deleting the branch failed. */
  branchError: stepErrorSchema.optional(),
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

// card.prClose

/** #329 D8: the PR comment and the issue comment `card.prClose` posts, in UTF-8 bytes. */
export const CARD_PR_CLOSE_COMMENT_MAX_BYTES = CARD_MERGE_COMMENT_MAX_BYTES;

/**
 * #329 D8 (ADR-0010, advertised per ADR-0023): Accept without merging closes
 * the card's PR through the runner's `gh`, in the project root —
 * `gh pr close <pr> --repo <o/r> --comment <comment>`, never a command text
 * (the API words it "Closed from the Nautelle Board (C-<n>)").
 *
 * - `deleteBranch`: then deletes the PR's head branch on GitHub as
 *   `card.merge` does (D7) — the head read from the PR, never the base.
 * - `issue`: then closes that issue as `not planned` with `comment`, when it
 *   is still open; `null` leaves the issue alone (the default in the dialog).
 *
 * A merged PR is refused (`merged`); an already closed one is a success with
 * `alreadyClosed`, and the branch and issue steps still run.
 *
 * Its own group, outside `cardCommands`: the `commands` allowlist enters it
 * beside them, with its runner handler (the capture and text precedent).
 */
export const cardPrCloseArgsSchema = z.strictObject({
  ...cardTarget,
  root: absolutePathSchema,
  pr: z.number().int().positive(),
  deleteBranch: z.boolean(),
  issue: z.number().int().positive().nullable(),
  comment: z
    .string()
    .min(1)
    .refine(noNul, { message: 'must not contain NUL' })
    .refine((t) => utf8Bytes(t) <= CARD_PR_CLOSE_COMMENT_MAX_BYTES, {
      message: `must be at most ${CARD_PR_CLOSE_COMMENT_MAX_BYTES} bytes`,
    }),
});
export type CardPrCloseArgs = z.infer<typeof cardPrCloseArgsSchema>;

/** The PR is closed — now, or before (`alreadyClosed`). */
export const cardPrCloseSuccessSchema = z.object({
  closed: z.literal(true),
  alreadyClosed: z.boolean(),
  /** `false` when not asked, or the deletion failed (`branchError`). */
  branchDeleted: z.boolean(),
  branchError: stepErrorSchema.optional(),
  /** `false` when not asked (`issue: null`), already closed, or it failed (`issueError`). */
  issueClosed: z.boolean(),
  issueError: stepErrorSchema.optional(),
});
export type CardPrCloseSuccess = z.infer<typeof cardPrCloseSuccessSchema>;

/**
 * #329 D8: why the close was refused; the API answers 409 `pr_close_failed`
 * with it as `reason` and keeps the card in Finished.
 */
export const cardPrCloseFailReasonSchema = z.enum(['merged', 'gh_failed']);
export type CardPrCloseFailReason = z.infer<typeof cardPrCloseFailReasonSchema>;

/** A refused close is a result, not a command error: nothing was closed. */
export const cardPrCloseFailureSchema = z.object({
  closed: z.literal(false),
  error: cardPrCloseFailReasonSchema,
  message: stepErrorSchema,
});
export type CardPrCloseFailure = z.infer<typeof cardPrCloseFailureSchema>;

export const cardPrCloseResultSchema = z.discriminatedUnion('closed', [
  cardPrCloseSuccessSchema,
  cardPrCloseFailureSchema,
]);
export type CardPrCloseResult = z.infer<typeof cardPrCloseResultSchema>;

/**
 * #329 D8: `card.prClose`, an operator command, in the `commands` allowlist
 * next to `cardCommands` (served by the runner's `closeCardPr`).
 */
export const cardPrCloseCommands = {
  'card.prClose': {
    args: cardPrCloseArgsSchema,
    result: cardPrCloseResultSchema,
    minRole: 'operator',
    timeoutMs: CARD_TIMEOUTS_MS.prClose,
  },
} as const satisfies Record<string, CommandDefinition>;

export type CardPrCloseCommandName = keyof typeof cardPrCloseCommands;

// card.checks

/** #359 D5: checks `card.checks` reports, at most. */
export const CARD_CHECKS_MAX = 100;

/**
 * #359 D5 (ADR-0010, advertised per ADR-0023): a card PR's head and checks,
 * read through the runner's `gh` in the project root — `gh pr view <pr>
 * --json state,isDraft,headRefOid,mergeable` and `gh pr checks <pr> --json
 * name,bucket,link`, never a command text. A PR with no checks answers
 * `checks: []`. CI logs are not read (the spec's out of scope).
 */
export const cardChecksArgsSchema = z.strictObject({
  ...cardTarget,
  root: absolutePathSchema,
  pr: z.number().int().positive(),
});
export type CardChecksArgs = z.infer<typeof cardChecksArgsSchema>;

/** `gh pr checks`' `bucket`: how GitHub classifies a check's state. */
export const cardCheckBucketSchema = z.enum([
  'pass',
  'fail',
  'pending',
  'skipping',
  'cancel',
]);
export type CardCheckBucket = z.infer<typeof cardCheckBucketSchema>;

export const cardCheckSchema = z.object({
  name: z.string().min(1).max(200),
  bucket: cardCheckBucketSchema,
  /** The check's details page; `null` when GitHub gives none. */
  link: z.url({ protocol: /^https$/ }).nullable(),
});
export type CardCheck = z.infer<typeof cardCheckSchema>;

/** `gh pr view`'s `mergeable`: `CONFLICTING` starts a conflict round (D6). */
export const cardPrMergeableSchema = z.enum([
  'MERGEABLE',
  'CONFLICTING',
  'UNKNOWN',
]);
export type CardPrMergeable = z.infer<typeof cardPrMergeableSchema>;

export const cardChecksResultSchema = z.object({
  /** The PR's state; `draft` is an open PR with `isDraft`. */
  state: z.enum(['open', 'draft', 'merged', 'closed']),
  /** The PR's head; the checks are this commit's. */
  headSha: headShaSchema,
  mergeable: cardPrMergeableSchema,
  checks: z.array(cardCheckSchema).max(CARD_CHECKS_MAX),
  /**
   * #709: the branch the PR goes (or went) into — `baseRefName`. Absent from
   * a runner older than #709.
   */
  base: z.string().min(1).max(255).optional(),
  /** #709: when GitHub merged the PR; `null` while it is not merged. */
  mergedAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
export type CardChecksResult = z.infer<typeof cardChecksResultSchema>;

/**
 * #359 D5: `card.checks`, an operator command. Exported here and entered in
 * the `commands` allowlist together with its runner handler, as
 * `cardPrCloseCommands` was.
 */
export const cardChecksCommands = {
  'card.checks': {
    args: cardChecksArgsSchema,
    result: cardChecksResultSchema,
    minRole: 'operator',
    timeoutMs: CARD_TIMEOUTS_MS.checks,
  },
} as const satisfies Record<string, CommandDefinition>;

export type CardChecksCommandName = keyof typeof cardChecksCommands;

// card.ciRetrigger

/**
 * #484 (ADR-0043, ADR-0010, advertised per ADR-0023): asks the forge to send
 * a card PR's pull-request event again, so a CI whose webhook delivery was
 * lost creates its pipeline — `gh pr view <pr> --json state,headRefOid`, then
 * `gh pr close <pr>` and `gh pr reopen <pr>`, argument arrays only, in the
 * project root. A reopened PR is an event every CI that runs on pull
 * requests listens to, and it adds no commit.
 *
 * Only an open (or draft) PR whose head is still `headSha` is closed: a
 * merged or closed PR, or one that moved on, is refused and left alone.
 */
export const cardCiRetriggerArgsSchema = z.strictObject({
  ...cardTarget,
  root: absolutePathSchema,
  pr: z.number().int().positive(),
  /** The head the API saw without checks. */
  headSha: headShaSchema,
});
export type CardCiRetriggerArgs = z.infer<typeof cardCiRetriggerArgsSchema>;

/**
 * Why nothing was retriggered: `not_open` — merged or closed; `head_moved` —
 * a newer head, which has its own event; `gh_failed` — `gh` could not view
 * or close it; `reopen_failed` — the PR was closed and stays closed.
 */
export const cardCiRetriggerFailReasonSchema = z.enum([
  'not_open',
  'head_moved',
  'gh_failed',
  'reopen_failed',
]);
export type CardCiRetriggerFailReason = z.infer<
  typeof cardCiRetriggerFailReasonSchema
>;

/** A refusal is a result, not a command error. */
export const cardCiRetriggerResultSchema = z.discriminatedUnion('retriggered', [
  z.object({ retriggered: z.literal(true) }),
  z.object({
    retriggered: z.literal(false),
    error: cardCiRetriggerFailReasonSchema,
    message: stepErrorSchema,
  }),
]);
export type CardCiRetriggerResult = z.infer<typeof cardCiRetriggerResultSchema>;

/**
 * #484: `card.ciRetrigger`, an operator command, in the `commands` allowlist
 * beside `card.checks`.
 */
export const cardCiRetriggerCommands = {
  'card.ciRetrigger': {
    args: cardCiRetriggerArgsSchema,
    result: cardCiRetriggerResultSchema,
    minRole: 'operator',
    timeoutMs: CARD_TIMEOUTS_MS.ciRetrigger,
  },
} as const satisfies Record<string, CommandDefinition>;

export type CardCiRetriggerCommandName = keyof typeof cardCiRetriggerCommands;

// card.prRetarget

/**
 * #636 (ADR-0064, ADR-0010, advertised per ADR-0023): moves a stacked card
 * PR onto another base once the dependency it was stacked on has merged —
 * `gh pr view <pr> --json state,baseRefName`, then `gh pr edit <pr> --base
 * <base>`, argument arrays only, in the project root. The control plane never
 * runs git itself (ADR-0001).
 *
 * Only an open (or draft) PR is edited; a PR already on `base` is left as it
 * is and answers `retargeted: true` with `alreadyThere`.
 */
export const cardPrRetargetArgsSchema = z.strictObject({
  ...cardTarget,
  root: absolutePathSchema,
  pr: z.number().int().positive(),
  /** The branch the PR goes into from now on — the project base. */
  base: gitRefSchema,
});
export type CardPrRetargetArgs = z.infer<typeof cardPrRetargetArgsSchema>;

/**
 * Why nothing was retargeted: `not_open` — merged or closed; `gh_failed` —
 * `gh` could not view or edit it.
 */
export const cardPrRetargetFailReasonSchema = z.enum(['not_open', 'gh_failed']);
export type CardPrRetargetFailReason = z.infer<
  typeof cardPrRetargetFailReasonSchema
>;

/** A refusal is a result, not a command error. */
export const cardPrRetargetResultSchema = z.discriminatedUnion('retargeted', [
  z.object({
    retargeted: z.literal(true),
    /** The PR already went into `base`; nothing was edited. */
    alreadyThere: z.boolean(),
  }),
  z.object({
    retargeted: z.literal(false),
    error: cardPrRetargetFailReasonSchema,
    message: stepErrorSchema,
  }),
]);
export type CardPrRetargetResult = z.infer<typeof cardPrRetargetResultSchema>;

/**
 * #636: `card.prRetarget`, an operator command, in the `commands` allowlist
 * beside `card.ciRetrigger`.
 */
export const cardPrRetargetCommands = {
  'card.prRetarget': {
    args: cardPrRetargetArgsSchema,
    result: cardPrRetargetResultSchema,
    minRole: 'operator',
    timeoutMs: CARD_TIMEOUTS_MS.prRetarget,
  },
} as const satisfies Record<string, CommandDefinition>;

export type CardPrRetargetCommandName = keyof typeof cardPrRetargetCommands;

// card.prOpen

/**
 * #709 (ADR-0064, ADR-0010, advertised per ADR-0023): opens a pull request of
 * a pushed card branch into `base` — the forward PR of a stacked card whose PR
 * merged into a dependency branch that had already merged. `gh pr list --head
 * <branch> --base <base> --state open` first, so an open PR is reused; else
 * `gh pr create`, then `gh pr view --json mergeable`. Argument arrays only,
 * the body through a private temporary file. The control plane never runs
 * git itself (ADR-0001).
 */
export const cardPrOpenArgsSchema = z.strictObject({
  ...cardTarget,
  root: absolutePathSchema,
  /** The card's branch, the PR's head. */
  branch: gitRefSchema,
  /** The branch the PR goes into — the project base. */
  base: gitRefSchema,
  title: prTitleSchema,
  body: prBodySchema,
});
export type CardPrOpenArgs = z.infer<typeof cardPrOpenArgsSchema>;

/**
 * Why no PR was opened: `no_commits` — `branch` has nothing `base` lacks, so
 * its work has landed; `no_branch` — `branch` is gone from GitHub;
 * `gh_failed` — `gh` could not list or create it.
 */
export const cardPrOpenFailReasonSchema = z.enum([
  'no_commits',
  'no_branch',
  'gh_failed',
]);
export type CardPrOpenFailReason = z.infer<typeof cardPrOpenFailReasonSchema>;

/** A refusal is a result, not a command error. */
export const cardPrOpenResultSchema = z.discriminatedUnion('opened', [
  z.object({
    opened: z.literal(true),
    prNumber: z.number().int().positive(),
    prUrl: z.url({ protocol: /^https$/ }),
    /** An open PR of `branch` into `base` existed; nothing was created. */
    alreadyOpen: z.boolean(),
    mergeable: cardPrMergeableSchema,
  }),
  z.object({
    opened: z.literal(false),
    error: cardPrOpenFailReasonSchema,
    message: stepErrorSchema,
  }),
]);
export type CardPrOpenResult = z.infer<typeof cardPrOpenResultSchema>;

/**
 * #709: `card.prOpen`, an operator command, in the `commands` allowlist
 * beside `card.prRetarget`.
 */
export const cardPrOpenCommands = {
  'card.prOpen': {
    args: cardPrOpenArgsSchema,
    result: cardPrOpenResultSchema,
    minRole: 'operator',
    timeoutMs: CARD_TIMEOUTS_MS.prOpen,
  },
} as const satisfies Record<string, CommandDefinition>;

export type CardPrOpenCommandName = keyof typeof cardPrOpenCommands;
