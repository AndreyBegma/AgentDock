import { z } from 'zod';
import type { CommandDefinition } from '../commands';
import { ISSUE_BODY_MAX_BYTES } from '../events/queue';
import { httpsGithubUrl } from '../github-url';

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

export const ISSUE_LABEL_MAX = 100;

/**
 * L-27: an issue label. `gh --label` splits on commas, so a comma would let
 * one label carry another past the runner's ready-label filter; control
 * characters have no place in a label either.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse them
export const ISSUE_LABEL_PATTERN = /^[^,\u0000-\u001f]{1,100}$/;

/**
 * L-27: the orchestrator's control labels (`cs:ready`, `cs:in-flight`, …).
 * Only the orchestrator and the runner's `queue` set them, never a caller.
 */
export const NOT_CONTROL_LABEL = /^(?!\s*cs:)/i;

export const isControlLabel = (label: string): boolean =>
  !NOT_CONTROL_LABEL.test(label);

/** A label a caller may ask for. */
export const issueLabelSchema = z
  .string()
  .regex(ISSUE_LABEL_PATTERN, {
    message: `must be 1-${ISSUE_LABEL_MAX} characters without commas or control characters`,
  })
  .refine((l) => !isControlLabel(l), {
    message: 'must not be an orchestrator control label (cs:*)',
  });

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
  labels: z.array(issueLabelSchema).max(ISSUE_LABELS_MAX),
  queue: z.boolean(),
  /**
   * The project's effective ready label (override, else config snapshot, else
   * `cs:ready`). Optional: an older API sends none and the runner falls back
   * to its own config.
   */
  readyLabel: z.string().trim().min(1).max(100).optional(),
});
export type IssueCreateArgs = z.infer<typeof issueCreateArgsSchema>;

export const issueCreateResultSchema = z.object({
  number: z.number().int().positive(),
  url: httpsGithubUrl,
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
