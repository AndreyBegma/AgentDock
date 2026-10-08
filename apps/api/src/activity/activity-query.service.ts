import {
  ACTIVITY_PAGE_DEFAULT,
  type ActivityItem,
  type ActivityPage,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthUser } from '../auth';
import { PrismaService } from '../database/prisma.service';
import { ProjectAccessService } from '../projects';
import { badCursor } from './activity-error';
import { toActivityItems } from './activity-mapper';
import type { ActivityListQuery, ProjectActivityQuery } from './dto';
import { decodeKeyset, encodeKeyset } from './keyset';

/** Feed reads (spec 21 "API", D10, D11). */
@Injectable()
export class ActivityQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
  ) {}

  /**
   * The caller's feed: items of the projects they can see, plus project-less
   * items for an admin only (D10). A `projectId` they cannot see is an empty
   * feed, never another project's items.
   */
  async global(
    user: AuthUser,
    query: ActivityListQuery,
  ): Promise<ActivityPage> {
    let scope: Prisma.ActivityItemWhereInput;
    if (user.role === 'admin') {
      scope = query.projectId ? { projectId: query.projectId } : {};
    } else {
      const visible = await this.prisma.project.findMany({
        where: {
          ...this.access.visibleWhere(user),
          ...(query.projectId ? { id: query.projectId } : {}),
        },
        select: { id: true },
      });
      scope = { projectId: { in: visible.map((p) => p.id) } };
    }
    return this.page(scope, query);
  }

  /** One project's feed; `ProjectAccessGuard` already let the caller in. */
  project(
    projectId: string,
    query: ProjectActivityQuery,
  ): Promise<ActivityPage> {
    return this.page({ projectId }, query);
  }

  /** The newest items of a slot within a run's window (run detail). */
  async forSlot(
    projectId: string,
    slot: string,
    from: Date,
    to: Date | null,
    limit: number,
  ): Promise<ActivityItem[]> {
    const rows = await this.prisma.activityItem.findMany({
      where: {
        projectId,
        slot,
        ts: { gte: from, ...(to ? { lte: to } : {}) },
      },
      orderBy: [{ ts: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return toActivityItems(this.prisma, rows);
  }

  private async page(
    scope: Prisma.ActivityItemWhereInput,
    query: ProjectActivityQuery,
  ): Promise<ActivityPage> {
    const limit = query.limit ?? ACTIVITY_PAGE_DEFAULT;
    const and: Prisma.ActivityItemWhereInput[] = [scope];
    if (query.category) and.push({ category: query.category });
    if (query.type) and.push({ type: query.type });
    if (query.actor) and.push({ actorId: query.actor });
    if (query.slot) and.push({ slot: query.slot });
    if (query.from) and.push({ ts: { gte: new Date(query.from) } });
    if (query.to) and.push({ ts: { lt: new Date(query.to) } });
    if (query.cursor) {
      const key = decodeKeyset(query.cursor);
      if (!key || !/^\d+$/.test(key.id)) throw badCursor();
      const id = BigInt(key.id);
      and.push({
        OR: [{ ts: { lt: key.at } }, { ts: key.at, id: { lt: id } }],
      });
    }
    const rows = await this.prisma.activityItem.findMany({
      where: { AND: and },
      orderBy: [{ ts: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: await toActivityItems(this.prisma, page),
      nextCursor:
        rows.length > limit && last
          ? encodeKeyset({ at: last.ts, id: last.id.toString() })
          : null,
    };
  }
}
