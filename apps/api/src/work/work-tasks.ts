import type {
  PlanStatus,
  PlanTaskIssueView,
  TaskDesignSummary,
} from '@nautelle/shared';
import type { PlanTask, Prisma } from '@prisma/client';
import type { Keyset } from '../activity/keyset';
import type { PrismaService } from '../database/prisma.service';
import { readablePlanWhere } from '../planner/plan-access';
import { type IssueViews, issueViewLoader } from '../planner/task-live';
import {
  afterKeyset,
  KEYSET_ORDER,
  type SourceSlice,
  scanKeyset,
} from './keyset-page';

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
  /** Narrows the tasks. */
  tasks?: Prisma.PlanTaskWhereInput[];
  /** Load the design chips (the board's face, D6); the List shows none. */
  designs?: boolean;
}

export interface WorkTaskPageQuery {
  /** Narrows the plans; the readable rule and the visible projects are always applied. */
  plans: Prisma.PlanWhereInput;
  /** Narrows the tasks in SQL (kind, search). */
  tasks?: Prisma.PlanTaskWhereInput[];
  /** The last row of the previous page. */
  after: Keyset | null;
  size: number;
  /** A filter derived after the join (the status); none keeps every task. */
  keep?: (row: WorkTask) => boolean;
}

const readablePlans = (
  prisma: PrismaService,
  userId: string,
  plans: Prisma.PlanWhereInput,
) =>
  prisma.plan.findMany({
    where: { AND: [readablePlanWhere(userId), plans] },
    select: {
      id: true,
      title: true,
      status: true,
      version: true,
      projectId: true,
      project: { select: { displayName: true } },
    },
  });

type PlanRow = Awaited<ReturnType<typeof readablePlans>>[number];

/** Tasks of the plans' current versions only. */
const currentTasks = (plans: PlanRow[]): Prisma.PlanTaskWhereInput => ({
  OR: plans.map((p) => ({ planId: p.id, planVersion: p.version })),
});

const toWorkPlan = (plan: PlanRow): WorkPlan => ({
  id: plan.id,
  title: plan.title,
  status: plan.status,
  projectId: plan.projectId,
  projectName: plan.project.displayName,
});

/** Joins tasks with their plan and issue, one issue read per project. */
const joinTasks = async (
  plans: ReadonlyMap<string, PlanRow>,
  tasks: PlanTask[],
  loaderOf: (
    projectId: string,
  ) => (tasks: readonly PlanTask[]) => Promise<IssueViews>,
): Promise<{ plan: PlanRow; task: PlanTask; issue: IssueViews }[]> => {
  const projectOf = (t: PlanTask) => plans.get(t.planId)?.projectId;
  const issueOf = new Map<string, IssueViews>();
  for (const projectId of new Set(tasks.map(projectOf))) {
    if (!projectId) continue;
    const own = tasks.filter((t) => projectOf(t) === projectId);
    issueOf.set(projectId, await loaderOf(projectId)(own));
  }
  return tasks.flatMap((task) => {
    const plan = plans.get(task.planId);
    const issue = plan && issueOf.get(plan.projectId);
    return plan && issue ? [{ plan, task, issue }] : [];
  });
};

/**
 * Tasks of the current version of every plan the caller may read
 * (`readablePlanWhere`, D3, D11), newest `updatedAt` first, with the live
 * status of the issued ones — as the project Board reads them. The live
 * status is derived, never stored, so filtering by it is the caller's.
 */
export const loadWorkTasks = async (
  prisma: PrismaService,
  userId: string,
  query: WorkTasksQuery,
): Promise<WorkTask[]> => {
  const plans = await readablePlans(prisma, userId, query.plans);
  if (plans.length === 0) return [];
  const tasks = await prisma.planTask.findMany({
    where: { AND: [currentTasks(plans), ...(query.tasks ?? [])] },
    orderBy: KEYSET_ORDER,
  });
  if (tasks.length === 0) return [];
  const designs = query.designs
    ? await designsOf(prisma, [...new Set(tasks.map((t) => t.planId))])
    : new Map<string, TaskDesignSummary>();
  const joined = await joinTasks(
    new Map(plans.map((p) => [p.id, p])),
    tasks,
    (projectId) => issueViewLoader(prisma, projectId),
  );
  return joined.map(({ plan, task, issue }) => ({
    plan: toWorkPlan(plan),
    task,
    issue: issue(task),
    design: designs.get(designKey(task.planId, task.key)) ?? null,
  }));
};

/**
 * One page of `loadWorkTasks` for the List (`GET /work`, `GET /tasks`; L-25):
 * the tasks are read in keyset order, a page plus one at a time, so a read
 * never grows with the project. A filter on the derived status reads on in
 * bounded batches (`scanKeyset`); the slice's horizon says where it stopped.
 */
export const pageWorkTasks = async (
  prisma: PrismaService,
  userId: string,
  query: WorkTaskPageQuery,
): Promise<SourceSlice<WorkTask>> => {
  const plans = await readablePlans(prisma, userId, query.plans);
  if (plans.length === 0) return { rows: [], horizon: null };
  const planBy = new Map(plans.map((p) => [p.id, p]));
  const current = currentTasks(plans);
  const loaders = new Map<string, ReturnType<typeof issueViewLoader>>();
  const loaderOf = (projectId: string) => {
    let loader = loaders.get(projectId);
    if (!loader) {
      loader = issueViewLoader(prisma, projectId);
      loaders.set(projectId, loader);
    }
    return loader;
  };
  return scanKeyset(
    query.size,
    query.after,
    (after, take) =>
      prisma.planTask.findMany({
        where: {
          AND: [
            current,
            ...(query.tasks ?? []),
            ...(after ? [afterKeyset(after)] : []),
          ],
        },
        orderBy: KEYSET_ORDER,
        take,
      }),
    async (batch) =>
      (await joinTasks(planBy, batch, loaderOf)).flatMap(
        ({ plan, task, issue }) => {
          const row: WorkTask = {
            plan: toWorkPlan(plan),
            task,
            issue: issue(task),
            design: null,
          };
          if (query.keep && !query.keep(row)) return [];
          return [{ key: { at: task.updatedAt, id: task.id }, item: row }];
        },
      ),
  );
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
