import { z } from 'zod';
import type { RunnerEvent } from '../envelope';

/**
 * Queue events (spec 19 D1, D2): what the runner's `issues` collector reads
 * from GitHub about a project's open issues. Every one names its project in
 * the envelope's `project`; `data` never repeats it. `source: "runner"`.
 */

/** Issue bodies are trimmed to this many bytes (UTF-8) before they are sent. */
export const ISSUE_BODY_MAX_BYTES = 64 * 1024;
/** Pull request bodies only feed `Closes #n`; trimmed harder. */
export const PULL_REQUEST_BODY_MAX_BYTES = 16 * 1024;
/**
 * Largest serialized `data` of one `issues.snapshot` part. Keeps a part, its
 * envelope and the rest of a batch under `MAX_EVENTS_BATCH_BYTES` (256 KB).
 */
export const ISSUES_SNAPSHOT_PART_MAX_BYTES = 192 * 1024;

const issueNumber = z.number().int().positive();

/** An open issue as the snapshot carries it (D2). */
export const snapshotIssueSchema = z.object({
  number: issueNumber,
  title: z.string(),
  labels: z.array(z.string().min(1)).default([]),
  /** GitHub logins. */
  assignees: z.array(z.string().min(1)).default([]),
  /** Markdown, trimmed to `ISSUE_BODY_MAX_BYTES`; `null` bodies are sent as `""`. */
  body: z.string().default(''),
  updatedAt: z.iso.datetime({ offset: true }),
  url: z.url(),
});
export type SnapshotIssue = z.infer<typeof snapshotIssueSchema>;

/**
 * An open pull request from the same listing (the issues endpoint returns
 * them with a `pull_request` key). Only its body is read: `Closes #n` puts
 * issue `n` in flight (D3).
 */
export const snapshotPullRequestSchema = z.object({
  number: issueNumber,
  title: z.string(),
  /** Trimmed to `PULL_REQUEST_BODY_MAX_BYTES`. */
  body: z.string().default(''),
  updatedAt: z.iso.datetime({ offset: true }),
  url: z.url(),
});
export type SnapshotPullRequest = z.infer<typeof snapshotPullRequestSchema>;

/**
 * One part of a project's open-issue listing, emitted only when the listing
 * changed (a `304` emits nothing). A listing too large for one event is split
 * into `parts` events sharing `snapshotId`, each at most
 * `ISSUES_SNAPSHOT_PART_MAX_BYTES`; every issue and pull request is in exactly
 * one part. **Every part carries the complete `open` list**, so the API closes
 * what is absent from it without reassembling the parts.
 */
export const issuesSnapshotDataSchema = z
  .object({
    /** Same for every part of one fetch. */
    snapshotId: z.string().min(1).max(100),
    fetchedAt: z.iso.datetime({ offset: true }),
    /** 0-based. */
    part: z.number().int().nonnegative(),
    parts: z.number().int().positive(),
    /** Every open issue and pull request number of the listing, all parts included. */
    open: z.array(issueNumber),
    issues: z.array(snapshotIssueSchema).default([]),
    pullRequests: z.array(snapshotPullRequestSchema).default([]),
  })
  .refine((d) => d.part < d.parts, { message: 'part must be below parts' });
export type IssuesSnapshotData = z.infer<typeof issuesSnapshotDataSchema>;

/**
 * How an issue named in a `Depends on` line was closed (D2). The runner emits
 * it for every such issue that is not open and whose closure it has not
 * reported since it started — read from the issue's timeline.
 */
export const issueClosedDataSchema = z
  .object({
    number: issueNumber,
    /** `pr`: closed by a merged pull request; `manual`: anything else. */
    closedBy: z.enum(['pr', 'manual']),
    /** The merged pull request, with `closedBy: "pr"`. */
    pr: issueNumber.optional(),
    closedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((d) => d.closedBy === 'pr' || d.pr === undefined, {
    message: 'pr is only set with closedBy "pr"',
  });
export type IssueClosedData = z.infer<typeof issueClosedDataSchema>;

/** The listing could not be read — `gh` missing, unauthenticated, rate limited. */
export const issuesUnavailableDataSchema = z.object({
  /** The `gh` error, without a stack trace. */
  reason: z.string().min(1).max(500),
});
export type IssuesUnavailableData = z.infer<typeof issuesUnavailableDataSchema>;

/** `data` schema of every queue event type. */
export const queueEventDataSchemas = {
  'issues.snapshot': issuesSnapshotDataSchema,
  'issue.closed': issueClosedDataSchema,
  'issues.unavailable': issuesUnavailableDataSchema,
} as const;

export type QueueEventType = keyof typeof queueEventDataSchemas;
export const QUEUE_EVENT_TYPES = Object.keys(
  queueEventDataSchemas,
) as QueueEventType[];

type ProjectEnvelope = NonNullable<RunnerEvent['project']>;

/** A queue event whose `data` has been parsed for its type. */
export type QueueEvent = {
  [T in QueueEventType]: Omit<RunnerEvent, 'type' | 'data' | 'project'> & {
    type: T;
    project: ProjectEnvelope;
    data: z.output<(typeof queueEventDataSchemas)[T]>;
  };
}[QueueEventType];

export const isQueueEventType = (type: string): type is QueueEventType =>
  Object.hasOwn(queueEventDataSchemas, type);

export type QueueEventParse =
  | { ok: true; event: QueueEvent }
  | { ok: false; reason: string };

/**
 * Parses the `data` of a queue event. `null` for a type that is not a queue
 * event; `ok: false` when the data does not fit or the envelope has no project.
 */
export const parseQueueEvent = (event: RunnerEvent): QueueEventParse | null => {
  if (!isQueueEventType(event.type)) return null;
  const type = event.type;
  if (!event.project) {
    return { ok: false, reason: `${type} without an envelope project` };
  }
  const parsed = queueEventDataSchemas[type].safeParse(event.data);
  if (!parsed.success) {
    return { ok: false, reason: `${type}: ${parsed.error.message}` };
  }
  return {
    ok: true,
    event: { ...event, type, data: parsed.data } as QueueEvent,
  };
};
