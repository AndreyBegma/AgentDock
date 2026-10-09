import { z } from 'zod';
import type { CommandDefinition } from '../commands';
import { ISSUE_BODY_MAX_BYTES } from '../events/queue';

/**
 * Queue commands (spec 19 D7, "API"). Defined and exported here, but entered
 * in the `commands` allowlist only together with their runner handlers: the
 * runner's `CommandHandlers` needs a handler for every key of that map, so an
 * entry without one breaks the runner build (spec 19, notes).
 */

/** `gh issue create` plus, with `queue`, a label edit; well under this. */
export const ISSUE_CREATE_TIMEOUT_MS = 45_000;
/** A full listing of several pages. */
export const ISSUES_REFRESH_TIMEOUT_MS = 45_000;

export const ISSUE_TITLE_MAX = 256;
export const ISSUE_LABELS_MAX = 20;

const byteLength = (text: string): number =>
  new TextEncoder().encode(text).length;

/**
 * `issue.create` — `gh issue create --repo <owner/repo>` in the project's
 * root. With `queue`, the runner adds the ready label only when the body
 * passes `specGap` (D7); otherwise it creates the issue unlabelled.
 */
export const issueCreateArgsSchema = z.strictObject({
  projectId: z.string().min(1),
  title: z.string().trim().min(1).max(ISSUE_TITLE_MAX),
  body: z.string().refine((b) => byteLength(b) <= ISSUE_BODY_MAX_BYTES, {
    message: `must be at most ${ISSUE_BODY_MAX_BYTES} bytes`,
  }),
  labels: z.array(z.string().min(1).max(100)).max(ISSUE_LABELS_MAX),
  queue: z.boolean(),
});
export type IssueCreateArgs = z.infer<typeof issueCreateArgsSchema>;

export const issueCreateResultSchema = z.object({
  number: z.number().int().positive(),
  url: z.url(),
  queued: z.boolean(),
  /** Why `queue: true` did not label it. */
  reason: z.enum(['no_acceptance_criteria', 'no_parallel_plan']).optional(),
});
export type IssueCreateResult = z.infer<typeof issueCreateResultSchema>;

export const issueCreateCommand = {
  args: issueCreateArgsSchema,
  result: issueCreateResultSchema,
  minRole: 'operator',
  timeoutMs: ISSUE_CREATE_TIMEOUT_MS,
} as const satisfies CommandDefinition;

/**
 * `issues.refresh` — poll the project's issues now instead of at the next
 * tick. A changed listing is emitted as `issues.snapshot` events as usual.
 */
export const issuesRefreshArgsSchema = z.strictObject({
  projectId: z.string().min(1),
});

export const issuesRefreshResultSchema = z.object({
  /** `false` on a `304`: nothing changed, nothing was emitted. */
  changed: z.boolean(),
  fetchedAt: z.iso.datetime({ offset: true }),
});
export type IssuesRefreshResult = z.infer<typeof issuesRefreshResultSchema>;

export const issuesRefreshCommand = {
  args: issuesRefreshArgsSchema,
  result: issuesRefreshResultSchema,
  minRole: 'operator',
  timeoutMs: ISSUES_REFRESH_TIMEOUT_MS,
} as const satisfies CommandDefinition;

/** The queue commands by wire name, for the runner slot to spread into `commands`. */
export const queueCommands = {
  'issue.create': issueCreateCommand,
  'issues.refresh': issuesRefreshCommand,
} as const;
