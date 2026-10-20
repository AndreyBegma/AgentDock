import type {
  PlanStatus,
  PlanTaskIssueView,
  TaskDesignSummary,
} from '@nautelle/shared';
import type { PlanTask, Prisma } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service';
import { readablePlanWhere } from '../planner/plan-access';
import { loadIssueViews } from '../planner/task-live';

/** The plan a task belongs to, as the Work surface shows it. */
export interface WorkPlan {
  id: string;
  title: string;
  status: PlanStatus;
  projectId: string;
  projectName: string;
}

/** A task of the current version of a readable plan, joined with its issue. */
export interface WorkTask {
  plan: WorkPlan;
  task: PlanTask;
  issue: PlanTaskIssueView | null;
  design: TaskDesignSummary | null;
}

export interface WorkTasksQuery {
  /** Narrows the plans; the readable rule and the visible projects are always applied. */
  plans: Prisma.PlanWhereInput;
  /** Narrows the tasks (kind, search, keyset bound). */
  tasks?: Prisma.PlanTaskWhereInput[];
  /** Load the design chips (the board's face, D6); the List shows none. */
  designs?: boolean;
}

/**
 * Tasks of the current version of every plan the caller may read
 * (`readablePlanWhere`, D3, D11), newest `updatedAt` first, with the live
 * status of the issued ones — as `GET /tasks` reads them. The live status is
 * derived, never stored, so filtering by it is the caller's, after the join.
 */
export const loadWorkTasks = async (
  prisma: PrismaService,
  userId: string,
  query: WorkTasksQuery,
): Promise<WorkTask[]> => {
  const plans = await prisma.plan.findMany({
    where: { AND: [readablePlanWhere(userId), query.plans] },
    select: {
      id: true,
      title: true,
      status: true,
      version: true,
      projectId: true,
      project: { select: { displayName: true } },
    },
  });
  if (plans.length === 0) return [];
  const planBy = new Map(plans.map((p) => [p.id, p]));
  const tasks = await prisma.planTask.findMany({
    where: {
      AND: [
        { OR: plans.map((p) => ({ planId: p.id, planVersion: p.version })) },
        ...(query.tasks ?? []),
      ],
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
  });
  if (tasks.length === 0) return [];

  const issueOf = new Map<string, (t: PlanTask) => PlanTaskIssueView | null>();
  for (const projectId of new Set(plans.map((p) => p.projectId))) {
    const own = tasks.filter(
      (t) => planBy.get(t.planId)?.projectId === projectId,
    );
    if (own.length === 0) continue;
    issueOf.set(projectId, await loadIssueViews(prisma, projectId, own));
  }
  const designs = query.designs
    ? await designsOf(prisma, [...new Set(tasks.map((t) => t.planId))])
    : new Map<string, TaskDesignSummary>();

  return tasks.flatMap((task) => {
    const plan = planBy.get(task.planId);
    if (!plan) return [];
    return [
      {
        plan: {
          id: plan.id,
          title: plan.title,
          status: plan.status,
          projectId: plan.projectId,
          projectName: plan.project.displayName,
        },
        task,
        issue: issueOf.get(plan.projectId)?.(task) ?? null,
        design: designs.get(designKey(task.planId, task.key)) ?? null,
      },
    ];
  });
};

const designKey = (planId: string, key: string): string => `${planId}\0${key}`;

/** The Design chip of each task, by plan and key; a design switched off is none. */
const designsOf = async (
  prisma: PrismaService,
  planIds: string[],
): Promise<Map<string, TaskDesignSummary>> => {
  const rows = await prisma.taskDesign.findMany({
    where: { planId: { in: planIds }, needed: true },
    select: {
      planId: true,
      taskKey: true,
      needed: true,
      suggested: true,
      suggestionWhy: true,
      variantCount: true,
      status: true,
      approvedRevisionId: true,
      busySince: true,
    },
  });
  return new Map(
    rows.flatMap(({ planId, taskKey, busySince, ...summary }) =>
      planId === null || taskKey === null
        ? []
        : [
            [
              designKey(planId, taskKey),
              { ...summary, busySince: busySince?.toISOString() ?? null },
            ] as const,
          ],
    ),
  );
};
