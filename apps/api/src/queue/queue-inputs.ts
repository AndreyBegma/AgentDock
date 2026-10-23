import { boardVerdicts, DEFAULT_READY_LABEL } from '@nautelle/shared';
import {
  type RoundDecisions,
  roundDecisionsSchema,
} from '@nautelle/shared/protocol';
import type { Prisma, PrismaClient } from '@prisma/client';
import { type CachedIssue, isReady, type QueueInputs } from './queue-state';

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * The ready label the orchestrator reads (D3): the project's override, else
 * `orchestrator.readyLabel` from the config snapshot, else `cs:ready`.
 */
export const readyLabelOf = (project: {
  readyLabelOverride: string | null;
  codeSentinelConfig: Prisma.JsonValue;
}): string => {
  if (project.readyLabelOverride) return project.readyLabelOverride;
  const config = project.codeSentinelConfig;
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    const orchestrator = config.orchestrator;
    if (
      orchestrator &&
      typeof orchestrator === 'object' &&
      !Array.isArray(orchestrator)
    ) {
      const label = orchestrator.readyLabel;
      if (typeof label === 'string' && label.trim() !== '') return label;
    }
  }
  return DEFAULT_READY_LABEL;
};

const strings = (value: Prisma.JsonValue): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];

/** A stored round's tables; a malformed one reads as empty. */
export const decisionsOf = (value: Prisma.JsonValue): RoundDecisions => {
  const parsed = roundDecisionsSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : { dispatching: [], heldForLead: [], notDispatching: [], inFlight: [] };
};

export type IssueRow = Prisma.IssueCacheGetPayload<object>;

/** The columns of an `issues_cache` row the queue reads, all but the body. */
const CACHED_ISSUE = {
  number: true,
  kind: true,
  title: true,
  state: true,
  labels: true,
  closedBy: true,
  snapshotAt: true,
} satisfies Prisma.IssueCacheSelect;

/**
 * Whether the queue reads an issue's body: an open pull request's `Closes #n`,
 * or a ready issue's gate, dependencies, spec and parallel plan. Every other
 * row — closed, unlabelled — is read for its state and labels only (L-25).
 */
export const needsBody = (
  issue: Omit<CachedIssue, 'body'>,
  readyLabel: string,
): boolean =>
  (issue.kind === 'pull_request' && issue.state === 'open') ||
  isReady({ ...issue, body: '' }, readyLabel);

export const labelsOf = (row: Pick<IssueRow, 'labels'>): string[] =>
  strings(row.labels);
export const assigneesOf = (row: IssueRow): string[] => strings(row.assignees);

/** The newest round of a project, by board date and `HHMM`. */
export const latestRound = (db: Db, projectId: string) =>
  db.round.findFirst({
    where: { projectId },
    orderBy: [{ date: 'desc' }, { label: 'desc' }],
  });

/**
 * Everything `computeQueue` reads for one project; null when it is gone. The
 * bodies are read second, for the rows `needsBody` names only (L-25); every
 * other row carries an empty body the computation never reads.
 */
export const loadQueueInputs = async (
  db: Db,
  projectId: string,
): Promise<QueueInputs | null> => {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { readyLabelOverride: true, codeSentinelConfig: true },
  });
  if (!project) return null;
  const readyLabel = readyLabelOf(project);
  const [rows, slots, round] = await Promise.all([
    db.issueCache.findMany({ where: { projectId }, select: CACHED_ISSUE }),
    db.slot.findMany({
      where: { projectId, status: { not: 'ended' } },
      select: { name: true, issue: true, branch: true },
    }),
    latestRound(db, projectId),
  ]);
  const issues = rows.map((row) => ({ ...row, labels: strings(row.labels) }));
  const wanted = issues
    .filter((i) => needsBody(i, readyLabel))
    .map((i) => i.number);
  const bodies =
    wanted.length === 0
      ? []
      : await db.issueCache.findMany({
          where: { projectId, number: { in: wanted } },
          select: { number: true, body: true },
        });
  const bodyOf = new Map(bodies.map((b) => [b.number, b.body]));
  return {
    readyLabel,
    issues: issues.map((i) => ({ ...i, body: bodyOf.get(i.number) ?? '' })),
    slots: slots.map((s) => ({ ...s, live: true })),
    round: round
      ? {
          updatedAt: round.updatedAt,
          verdicts: boardVerdicts(decisionsOf(round.decisions)),
        }
      : null,
  };
};
