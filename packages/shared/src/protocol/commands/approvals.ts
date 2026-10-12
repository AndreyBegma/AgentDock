import { z } from 'zod';
import type { CommandDefinition } from '../commands';
import { prChecksSchema } from '../events/fleet';
import { absolutePathSchema } from '../projects';

/**
 * Merge approval commands (docs/specs/20-merge-approval-queue.md D4–D6, D11).
 *
 * Defined and exported here, but entered in the `commands` allowlist only
 * together with their runner handlers: the runner's `CommandHandlers` needs a
 * handler for every key of that map, so an entry without one breaks the
 * runner build (spec 20, notes).
 *
 * The decision commands carry the person's intent, never the approval
 * signal's file format: that contract belongs to plugin#8 and lives in one
 * runner module (D5), so a change to it touches no schema here.
 */

/** D4: `gh pr view` of a large PR, one call. */
export const PR_INSPECT_TIMEOUT_MS = 30_000;
/** A signal write is one small file; generous for a slow disk. */
export const PR_DECISION_TIMEOUT_MS = 10_000;

/** D4: changed files beyond this are dropped, and `filesTruncated` is set. */
export const PR_INSPECT_FILES_MAX = 300;
/** The PR body as `pr.inspect` returns it, in UTF-8 bytes. */
export const PR_INSPECT_BODY_MAX_BYTES = 64 * 1024;
/** D7: a request-changes note, in UTF-8 bytes. */
export const APPROVAL_NOTE_MAX_BYTES = 4 * 1024;
/** Who decided, as written into the signal. */
export const APPROVAL_BY_MAX_LENGTH = 320;

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

/** A full git commit id, lower-case hex. */
export const headShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, 'must be a 40-character lower-case hex commit id');

const prTarget = {
  projectId: z.string().min(1),
  root: absolutePathSchema,
  pr: z.number().int().positive(),
};

/** `pr.inspect` — `gh pr view <pr> --json …` in the project's root (D4). */
export const prInspectArgsSchema = z.strictObject(prTarget);
export type PrInspectArgs = z.infer<typeof prInspectArgsSchema>;

export const prInspectStateSchema = z.enum(['open', 'merged', 'closed']);
export type PrInspectState = z.infer<typeof prInspectStateSchema>;

/** One check of `statusCheckRollup`, classified like `rollupChecks`. */
export const prCheckSchema = z.object({
  name: z.string(),
  state: z.enum(['pass', 'wait', 'fail']),
  url: z.string().optional(),
});
export type PrCheck = z.infer<typeof prCheckSchema>;

export const prFileSchema = z.object({
  path: z.string().min(1),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type PrFile = z.infer<typeof prFileSchema>;

export const prInspectionSchema = z.object({
  number: z.number().int().positive(),
  url: z.url(),
  title: z.string(),
  /** Trimmed by the runner to `PR_INSPECT_BODY_MAX_BYTES`. */
  body: z.string(),
  state: prInspectStateSchema,
  /** `headRefOid` — what a decision binds to (D6). */
  headSha: headShaSchema,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  files: z.array(prFileSchema).max(PR_INSPECT_FILES_MAX),
  /** More than `PR_INSPECT_FILES_MAX` files changed. */
  filesTruncated: z.boolean(),
  /** The rollup of `checkList` (`rollupChecks`). */
  checks: prChecksSchema,
  checkList: z.array(prCheckSchema),
  /** GitHub's `mergeable`: `MERGEABLE`, `CONFLICTING` or `UNKNOWN`. */
  mergeable: z.string(),
  /** GitHub's `mergeStateStatus`: `CLEAN`, `BEHIND`, `BLOCKED`, … */
  mergeStateStatus: z.string(),
  fetchedAt: z.iso.datetime({ offset: true }),
});
export type PrInspection = z.infer<typeof prInspectionSchema>;

export const prInspectCommand = {
  args: prInspectArgsSchema,
  result: prInspectionSchema,
  minRole: 'viewer',
  timeoutMs: PR_INSPECT_TIMEOUT_MS,
} as const satisfies CommandDefinition;

const decision = {
  ...prTarget,
  /** The head the person saw; the decision is void for any other (D6). */
  headSha: headShaSchema,
  /** Who decided: the user's name or email. */
  by: z.string().trim().min(1).max(APPROVAL_BY_MAX_LENGTH),
  at: z.iso.datetime({ offset: true }),
};

/** `pr.approve` — signal the orchestrator that it may merge (D5). */
export const prApproveArgsSchema = z.strictObject(decision);
export type PrApproveArgs = z.infer<typeof prApproveArgsSchema>;

export const approvalNoteSchema = z
  .string()
  .refine((n) => n.trim().length > 0, { message: 'must not be blank' })
  .refine((n) => utf8Bytes(n) <= APPROVAL_NOTE_MAX_BYTES, {
    message: `must be at most ${APPROVAL_NOTE_MAX_BYTES} bytes`,
  });

/** `pr.requestChanges` — signal the orchestrator to send `note` to the worker (D7). */
export const prRequestChangesArgsSchema = z.strictObject({
  ...decision,
  note: approvalNoteSchema,
});
export type PrRequestChangesArgs = z.infer<typeof prRequestChangesArgsSchema>;

/**
 * `pr.voidApproval` — the PR's head moved after an approval (D6): withdraw the
 * signal for `headSha`. Sent by the API itself (system actor). How the signal
 * says so — a `stale` decision or no file at all — is the signal module's call.
 */
export const prVoidApprovalArgsSchema = z.strictObject({
  ...prTarget,
  /** The head that was approved and is now superseded. */
  headSha: headShaSchema,
  at: z.iso.datetime({ offset: true }),
});
export type PrVoidApprovalArgs = z.infer<typeof prVoidApprovalArgsSchema>;

export const approvalSignalResultSchema = z.object({
  written: z.literal(true),
});
export type ApprovalSignalResult = z.infer<typeof approvalSignalResultSchema>;

export const prApproveCommand = {
  args: prApproveArgsSchema,
  result: approvalSignalResultSchema,
  minRole: 'operator',
  timeoutMs: PR_DECISION_TIMEOUT_MS,
} as const satisfies CommandDefinition;

export const prRequestChangesCommand = {
  args: prRequestChangesArgsSchema,
  result: approvalSignalResultSchema,
  minRole: 'operator',
  timeoutMs: PR_DECISION_TIMEOUT_MS,
} as const satisfies CommandDefinition;

export const prVoidApprovalCommand = {
  args: prVoidApprovalArgsSchema,
  result: approvalSignalResultSchema,
  minRole: 'operator',
  timeoutMs: PR_DECISION_TIMEOUT_MS,
} as const satisfies CommandDefinition;

/** The approval commands by wire name, for the runner slot to spread into `commands`. */
export const approvalCommands = {
  'pr.inspect': prInspectCommand,
  'pr.approve': prApproveCommand,
  'pr.requestChanges': prRequestChangesCommand,
  'pr.voidApproval': prVoidApprovalCommand,
} as const;
export type ApprovalCommandName = keyof typeof approvalCommands;
