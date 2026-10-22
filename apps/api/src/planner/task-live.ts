import { type PlanTaskIssueView, parseClosingRefs } from '@nautelle/shared';
import type { PrismaService } from '../database/prisma.service';
import { readyLabelOf } from '../queue/queue-inputs';
import { liveStatusOf } from './task-status';

/** An issued task, as the live status needs it. */
export interface IssuedTask {
  issueNumber: number | null;
  issueUrl: string | null;
  queuedAt: Date | null;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];

export type IssueViews = (task: IssuedTask) => PlanTaskIssueView | null;

/** What every read of one project's issue views shares. */
interface ProjectFacts {
  repo: string;
  readyLabel: string;
  /** Issue → the first open pull request whose body closes it. */
  prBy: Map<number, { number: number; url: string }>;
}

const loadProjectFacts = async (
  prisma: PrismaService,
  projectId: string,
): Promise<ProjectFacts> => {
  const [project, openPrs] = await Promise.all([
    prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: {
        repo: true,
        readyLabelOverride: true,
        codeSentinelConfig: true,
      },
    }),
    prisma.issueCache.findMany({
      where: { projectId, kind: 'pull_request', state: 'open' },
      select: { number: true, url: true, body: true },
    }),
  ]);
  const prBy = new Map<number, { number: number; url: string }>();
  for (const pr of openPrs) {
    for (const n of parseClosingRefs(pr.body)) {
      if (!prBy.has(n)) prBy.set(n, { number: pr.number, url: pr.url });
    }
  }
  return { repo: project.repo, readyLabel: readyLabelOf(project), prBy };
};

/**
 * The GitHub side of one project's issued tasks (spec "Data / Schema"):
 * joined from #19's issue cache and queue states, and the open pull requests
 * that close them. Returns a lookup by issue number.
 */
export const loadIssueViews = (
  prisma: PrismaService,
  projectId: string,
  tasks: readonly IssuedTask[],
): Promise<IssueViews> => issueViewLoader(prisma, projectId)(tasks);

/**
 * `loadIssueViews` for a reader that pages one project's tasks in several
 * reads (L-25): the project and its open pull requests are read once, on the
 * first read with an issued task; each read joins only its own issues.
 */
export const issueViewLoader = (
  prisma: PrismaService,
  projectId: string,
): ((tasks: readonly IssuedTask[]) => Promise<IssueViews>) => {
  let facts: Promise<ProjectFacts> | null = null;
  return (tasks) => {
    const numbers = tasks
      .map((t) => t.issueNumber)
      .filter((n): n is number => n !== null);
    if (numbers.length === 0) return Promise.resolve(() => null);
    facts ??= loadProjectFacts(prisma, projectId);
    return joinIssueViews(prisma, projectId, numbers, facts);
  };
};

const joinIssueViews = async (
  prisma: PrismaService,
  projectId: string,
  numbers: number[],
  facts: Promise<ProjectFacts>,
): Promise<IssueViews> => {
  const [{ repo, readyLabel, prBy }, issues, states] = await Promise.all([
    facts,
    prisma.issueCache.findMany({
      where: { projectId, kind: 'issue', number: { in: numbers } },
      select: {
        number: true,
        state: true,
        labels: true,
        closedBy: true,
        closingPr: true,
      },
    }),
    prisma.queueStateRow.findMany({
      where: { projectId, issueNumber: { in: numbers } },
      select: { issueNumber: true, state: true },
    }),
  ]);
  const issueBy = new Map(issues.map((i) => [i.number, i]));
  const stateBy = new Map(states.map((s) => [s.issueNumber, s.state]));
  const prUrl = (n: number) => `https://github.com/${repo}/pull/${n}`;

  return (task) => {
    if (task.issueNumber === null || task.issueUrl === null) return null;
    const issue = issueBy.get(task.issueNumber);
    const openPr = prBy.get(task.issueNumber) ?? null;
    const live = liveStatusOf({
      issue: issue
        ? {
            state: issue.state,
            labels: strings(issue.labels),
            closedBy: issue.closedBy,
            closingPr: issue.closingPr,
          }
        : null,
      readyLabel,
      queueState: stateBy.get(task.issueNumber) ?? null,
      openPr,
      queuedAt: task.queuedAt,
    });
    return {
      number: task.issueNumber,
      url: task.issueUrl,
      liveStatus: live.status,
      prNumber: live.prNumber,
      prUrl:
        live.prNumber === null
          ? null
          : openPr?.number === live.prNumber
            ? openPr.url
            : prUrl(live.prNumber),
    };
  };
};
