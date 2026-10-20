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

/**
 * The GitHub side of one project's issued tasks (spec "Data / Schema"):
 * joined from #19's issue cache and queue states, and the open pull requests
 * that close them. Returns a lookup by issue number.
 */
export const loadIssueViews = async (
  prisma: PrismaService,
  projectId: string,
  tasks: readonly IssuedTask[],
): Promise<(task: IssuedTask) => PlanTaskIssueView | null> => {
  const numbers = tasks
    .map((t) => t.issueNumber)
    .filter((n): n is number => n !== null);
  if (numbers.length === 0) return () => null;
  const [project, issues, states, openPrs] = await Promise.all([
    prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: {
        repo: true,
        readyLabelOverride: true,
        codeSentinelConfig: true,
      },
    }),
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
    prisma.issueCache.findMany({
      where: { projectId, kind: 'pull_request', state: 'open' },
      select: { number: true, url: true, body: true },
    }),
  ]);
  const readyLabel = readyLabelOf(project);
  const issueBy = new Map(issues.map((i) => [i.number, i]));
  const stateBy = new Map(states.map((s) => [s.issueNumber, s.state]));
  const prBy = new Map<number, { number: number; url: string }>();
  for (const pr of openPrs) {
    for (const n of parseClosingRefs(pr.body)) {
      if (!prBy.has(n)) prBy.set(n, { number: pr.number, url: pr.url });
    }
  }
  const prUrl = (n: number) => `https://github.com/${project.repo}/pull/${n}`;

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
