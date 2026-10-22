import {
  PLANNER_ERROR,
  type TaskPage,
  type TaskRow,
  type TasksQuery,
} from '@nautelle/shared';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { decodeKeyset, encodeKeyset } from '../activity/keyset';
import type { AuthUser } from '../auth';
import { PrismaService } from '../database/prisma.service';
import { ProjectAccessService } from '../projects';
import { mergeKeysetPage } from '../work/keyset-page';
import { pageWorkTasks, type WorkTask } from '../work/work-tasks';
import { plannerError } from './planner-error';

export const TASK_PAGE_SIZE = 50;

/**
 * `GET /tasks` (spec 172 "API"): tasks of the current version of every plan
 * the caller may read, in the projects they can see, with the live status of
 * the issued ones. A page is keyed by `(updatedAt, id)` descending and reads
 * a page plus one (L-25); the live status is derived, never stored, so a
 * status filter reads on in bounded batches (`pageWorkTasks`).
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
    const tasks: Prisma.PlanTaskWhereInput[] = [];
    if (query.kind) tasks.push({ kind: query.kind });
    if (query.q) {
      tasks.push({
        OR: [
          { title: { contains: query.q, mode: 'insensitive' } },
          { key: { equals: query.q.toLowerCase() } },
        ],
      });
    }
    const statusOf = ({ task, issue }: WorkTask) =>
      issue?.liveStatus ?? task.status;
    const slice = await pageWorkTasks(this.prisma, user.id, {
      plans: {
        project: this.access.visibleWhere(user),
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.planId ? { id: query.planId } : {}),
      },
      tasks,
      after,
      size: TASK_PAGE_SIZE,
      ...(query.status
        ? { keep: (r: WorkTask) => statusOf(r) === query.status }
        : {}),
    });
    const { items, next } = mergeKeysetPage(
      [
        {
          horizon: slice.horizon,
          rows: slice.rows.map(({ key, item: row }) => ({
            key,
            item: {
              projectId: row.plan.projectId,
              projectName: row.plan.projectName,
              planId: row.plan.id,
              planTitle: row.plan.title,
              taskId: row.task.id,
              key: row.task.key,
              title: row.task.title,
              kind: row.task.kind,
              status: statusOf(row),
              issue: row.issue,
              updatedAt: row.task.updatedAt.toISOString(),
            } satisfies TaskRow,
          })),
        },
      ],
      TASK_PAGE_SIZE,
    );
    return { items, nextCursor: next ? encodeKeyset(next) : null };
  }
}
