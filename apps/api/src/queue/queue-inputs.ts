import { boardVerdicts, DEFAULT_READY_LABEL } from '@agentdock/shared';
import {
  type RoundDecisions,
  roundDecisionsSchema,
} from '@agentdock/shared/protocol';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { CachedIssue, QueueInputs } from './queue-state';

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

export const toCachedIssue = (row: IssueRow): CachedIssue => ({
  number: row.number,
  kind: row.kind,
  title: row.title,
  state: row.state,
  labels: strings(row.labels),
  body: row.body,
  closedBy: row.closedBy,
  snapshotAt: row.snapshotAt,
});

export const labelsOf = (row: Pick<IssueRow, 'labels'>): string[] =>
  strings(row.labels);
export const assigneesOf = (row: IssueRow): string[] => strings(row.assignees);

/** The newest round of a project, by board date and `HHMM`. */
export const latestRound = (db: Db, projectId: string) =>
  db.round.findFirst({
    where: { projectId },
    orderBy: [{ date: 'desc' }, { label: 'desc' }],
  });

/** Everything `computeQueue` reads for one project; null when it is gone. */
export const loadQueueInputs = async (
  db: Db,
  projectId: string,
): Promise<{ inputs: QueueInputs; issues: IssueRow[] } | null> => {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { readyLabelOverride: true, codeSentinelConfig: true },
  });
  if (!project) return null;
  const [issues, slots, round] = await Promise.all([
    db.issueCache.findMany({ where: { projectId } }),
    db.slot.findMany({
      where: { projectId, status: { not: 'ended' } },
      select: { name: true, issue: true, branch: true },
    }),
    latestRound(db, projectId),
  ]);
  return {
    issues,
    inputs: {
      readyLabel: readyLabelOf(project),
      issues: issues.map(toCachedIssue),
      slots: slots.map((s) => ({ ...s, live: true })),
      round: round
        ? {
            updatedAt: round.updatedAt,
            verdicts: boardVerdicts(decisionsOf(round.decisions)),
          }
        : null,
    },
  };
};
