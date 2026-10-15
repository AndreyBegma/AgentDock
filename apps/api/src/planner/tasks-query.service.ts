import {
  PLANNER_ERROR,
  type PlanTaskIssueView,
  type TaskPage,
  type TaskRow,
  type TasksQuery,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { decodeKeyset, encodeKeyset } from '../activity/keyset';
import type { AuthUser } from '../auth';
import { PrismaService } from '../database/prisma.service';
import { ProjectAccessService } from '../projects';
import { readablePlanWhere } from './plan-access';
import { plannerError } from './planner-error';
import { loadIssueViews } from './task-live';

export const TASK_PAGE_SIZE = 50;

/**
 * `GET /tasks` (spec 172 "API"): tasks of the current version of every plan
 * the caller may read, in the projects they can see, with the live status of
 * the issued ones. The live status is derived, never stored, so filtering by
 * it happens after the join; a page is keyed by `(updatedAt, id)` descending.
 */
@Injectable()
export class TasksQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
  ) {}

  async list(user: AuthUser, query: TasksQuery): Promise<TaskPage> {
    const after = query.cursor ? decodeKeyset(query.cursor) : null;
    if (query.cursor && !after) {
      throw plannerError(400, PLANNER_ERROR.invalidArgs, 'Unknown cursor');
    }
    const plans = await this.prisma.plan.findMany({
      where: {
        ...readablePlanWhere(user.id),
        project: this.access.visibleWhere(user),
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.planId ? { id: query.planId } : {}),
      },
      select: {
        id: true,
        title: true,
        version: true,
        projectId: true,
        project: { select: { displayName: true } },
      },
    });
    if (plans.length === 0) return { items: [], nextCursor: null };
    const planBy = new Map(plans.map((p) => [p.id, p]));
    const and: Prisma.PlanTaskWhereInput[] = [
      { OR: plans.map((p) => ({ planId: p.id, planVersion: p.version })) },
    ];
    if (query.kind) and.push({ kind: query.kind });
    if (query.q) {
      and.push({
        OR: [
          { title: { contains: query.q, mode: 'insensitive' } },
          { key: { equals: query.q.toLowerCase() } },
        ],
      });
    }
    const tasks = await this.prisma.planTask.findMany({
      where: { AND: and },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });

    const viewsByProject = new Map<
      string,
      (t: (typeof tasks)[number]) => PlanTaskIssueView | null
    >();
    for (const projectId of new Set(plans.map((p) => p.projectId))) {
      const own = tasks.filter(
        (t) => planBy.get(t.planId)?.projectId === projectId,
      );
      viewsByProject.set(
        projectId,
        await loadIssueViews(this.prisma, projectId, own),
      );
    }

    const rows: TaskRow[] = [];
    for (const task of tasks) {
      const plan = planBy.get(task.planId);
      if (!plan) continue;
      const issue = viewsByProject.get(plan.projectId)?.(task) ?? null;
      rows.push({
        projectId: plan.projectId,
        projectName: plan.project.displayName,
        planId: plan.id,
        planTitle: plan.title,
        taskId: task.id,
        key: task.key,
        title: task.title,
        kind: task.kind,
        status: issue?.liveStatus ?? task.status,
        issue,
        updatedAt: task.updatedAt.toISOString(),
      });
    }
    const filtered = rows.filter(
      (r) =>
        (!query.status || r.status === query.status) &&
        (!after ||
          new Date(r.updatedAt) < after.at ||
          (new Date(r.updatedAt).getTime() === after.at.getTime() &&
            r.taskId < after.id)),
    );
    const page = filtered.slice(0, TASK_PAGE_SIZE);
    const last = page.at(-1);
    return {
      items: page,
      nextCursor:
        filtered.length > TASK_PAGE_SIZE && last
          ? encodeKeyset({ at: new Date(last.updatedAt), id: last.taskId })
          : null,
    };
  }
}
