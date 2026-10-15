import {
  BOARD_COMPLETED_PAGE_SIZE,
  type BoardPlanTasksView,
  type BoardPlanTaskView,
  boardColumnOfPlanTask,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth';
import { PrismaService } from '../database/prisma.service';
import { loadWorkTasks } from './work-tasks';

/**
 * `GET /projects/:projectId/work/plan-tasks` (issue #270 D2–D4, D8): the plan
 * tasks the project Board shows beside its cards — read-only, in the column
 * their status and issue derive. The caller is a member (`ProjectAccessGuard`).
 */
@Injectable()
export class PlanTasksService {
  constructor(private readonly prisma: PrismaService) {}

  async board(user: AuthUser, projectId: string): Promise<BoardPlanTasksView> {
    const rows = await loadWorkTasks(this.prisma, user.id, {
      plans: { projectId },
      designs: true,
    });
    const items: BoardPlanTaskView[] = [];
    let completed = 0;
    // Newest first (D4); Completed keeps the newest page only (D3).
    for (const { plan, task, issue, design } of rows) {
      const column = boardColumnOfPlanTask({
        planStatus: plan.status,
        status: task.status,
        liveStatus: issue?.liveStatus ?? null,
      });
      if (column === null) continue;
      if (column === 'completed') {
        if (completed === BOARD_COMPLETED_PAGE_SIZE) continue;
        completed += 1;
      }
      items.push({
        planId: plan.id,
        planTitle: plan.title,
        taskId: task.id,
        key: task.key,
        title: task.title,
        kind: task.kind,
        column,
        status: issue?.liveStatus ?? task.status,
        issue,
        design,
        summary: task.summary,
        updatedAt: task.updatedAt.toISOString(),
      });
    }
    return { projectId, items };
  }
}
