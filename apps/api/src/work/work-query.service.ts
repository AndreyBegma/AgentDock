import {
  BOARD_COLUMNS,
  type BoardColumn,
  cardLabel,
  effectiveProjectRole,
  FLEET_STAGES,
  type FleetStage,
  parseWorkSearch,
  projectRoleAtLeast,
  WORK_PAGE_SIZE,
  type WorkItem,
  type WorkPage,
  type WorkQuery,
  type WorkSearch,
  workCardHref,
  workPlanTaskHref,
  workStatusOfPlanTask,
} from '@nautelle/shared';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { decodeKeyset, encodeKeyset, type Keyset } from '../activity/keyset';
import type { AuthUser } from '../auth';
import { PrismaService } from '../database/prisma.service';
import { ProjectAccessService } from '../projects';
import { unknownCursor } from './work-error';
import { loadWorkTasks } from './work-tasks';

interface Row {
  key: Keyset;
  item: WorkItem;
}

const isFleetStage = (value: string): value is FleetStage =>
  (FLEET_STAGES as readonly string[]).includes(value);

/** #388: a mirrored fleet slot is `fleet`, an Inbox suggestion `inbox`, the rest `card`. */
export const workSourceOfCard = (card: {
  source: string;
  column: string;
}): 'card' | 'inbox' | 'fleet' =>
  card.source === 'fleet'
    ? 'fleet'
    : card.column === 'inbox'
      ? 'inbox'
      : 'card';

/** `(updatedAt, id)` descending: newer first, then the larger id. */
const before = (a: Keyset, b: Keyset): boolean =>
  a.at.getTime() < b.at.getTime() ||
  (a.at.getTime() === b.at.getTime() && a.id < b.id);

/**
 * `GET /work` (issue #270 D10, D11): board cards, plan tasks and — for the
 * projects the caller operates — Inbox suggestions, across the projects they
 * can see, in one keyset `(updatedAt, id)` descending. A plan task's status
 * is derived after the join (as `GET /tasks`), so both sources are merged and
 * paged here rather than in SQL; the SQL bound `updatedAt <= cursor` only
 * trims what cannot be on the page.
 */
@Injectable()
export class WorkQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
  ) {}

  async list(user: AuthUser, query: WorkQuery): Promise<WorkPage> {
    const after = query.cursor ? decodeKeyset(query.cursor) : null;
    if (query.cursor && !after) throw unknownCursor();
    const text = query.q?.trim();
    const search = text ? parseWorkSearch(text) : null;

    const [cards, tasks] = await Promise.all([
      this.cards(user, query, search, after),
      this.tasks(user, query, search, after),
    ]);
    const rows = [...cards, ...tasks]
      .filter((r) => !after || before(r.key, after))
      .sort((a, b) =>
        before(a.key, b.key) ? 1 : before(b.key, a.key) ? -1 : 0,
      );
    const page = rows.slice(0, WORK_PAGE_SIZE);
    const last = page.at(-1);
    return {
      items: page.map((r) => r.item),
      nextCursor:
        rows.length > WORK_PAGE_SIZE && last ? encodeKeyset(last.key) : null,
    };
  }

  /**
   * D11: the projects whose Inbox the caller may see — operator or above
   * there. `null`: every project they can see (a site admin).
   */
  private async inboxProjects(user: AuthUser): Promise<string[] | null> {
    if (user.role === 'admin') return null;
    const members = await this.prisma.projectMember.findMany({
      where: { userId: user.id },
      select: { projectId: true, roleOverride: true },
    });
    return members
      .filter((m) =>
        projectRoleAtLeast(
          effectiveProjectRole(user.role, m.roleOverride),
          'operator',
        ),
      )
      .map((m) => m.projectId);
  }

  private async cards(
    user: AuthUser,
    query: WorkQuery,
    search: WorkSearch | null,
    after: Keyset | null,
  ): Promise<Row[]> {
    // A plan filter or `rejected` names plan tasks only (D10).
    if (
      query.source === 'plan' ||
      query.planId ||
      query.status === 'rejected'
    ) {
      return [];
    }
    const wanted = BOARD_COLUMNS.filter(
      (c: BoardColumn) =>
        (query.source === 'inbox'
          ? c === 'inbox'
          : (query.source !== 'card' && query.source !== 'fleet') ||
            c !== 'inbox') &&
        (!query.status || query.status === c),
    );
    if (wanted.length === 0) return [];
    const open = wanted.filter((c) => c !== 'inbox');
    const columns: Prisma.BoardCardWhereInput[] = [];
    if (open.length > 0) columns.push({ column: { in: open } });
    if (wanted.includes('inbox')) {
      const inbox = await this.inboxProjects(user);
      if (inbox === null) columns.push({ column: 'inbox' });
      else if (inbox.length > 0) {
        columns.push({ column: 'inbox', projectId: { in: inbox } });
      }
    }
    if (columns.length === 0) return [];

    const and: Prisma.BoardCardWhereInput[] = [
      { project: this.access.visibleWhere(user) },
      { OR: columns },
    ];
    if (query.projectId) and.push({ projectId: query.projectId });
    if (query.kind) and.push({ kind: query.kind });
    // #388: `fleet` is its own source; `card` and `inbox` no longer include it.
    if (query.source === 'fleet') and.push({ source: 'fleet' });
    else if (query.source) and.push({ source: { not: 'fleet' } });
    if (after) and.push({ updatedAt: { lte: after.at } });
    if (search) {
      const or: Prisma.BoardCardWhereInput[] = [
        { title: { contains: search.text, mode: 'insensitive' } },
      ];
      if (search.cardNumber !== null) or.push({ number: search.cardNumber });
      if (search.issueNumber !== null) {
        or.push({ issueNumber: search.issueNumber });
      }
      and.push({ OR: or });
    }
    const cards = await this.prisma.boardCard.findMany({
      where: { AND: and },
      include: {
        project: { select: { displayName: true } },
        rounds: {
          orderBy: { round: 'desc' },
          take: 1,
          select: { phase: true },
        },
      },
    });
    return cards.map((card) => ({
      key: { at: card.updatedAt, id: card.id },
      item: {
        source: workSourceOfCard(card),
        projectId: card.projectId,
        projectName: card.project.displayName,
        cardId: card.id,
        number: card.number,
        label: cardLabel(card.number),
        title: card.title,
        kind: card.kind,
        column: card.column,
        roundPhase: card.rounds[0]?.phase ?? null,
        issueNumber: card.issueNumber,
        issueUrl: card.issueUrl,
        prNumber: card.prNumber,
        prUrl: card.prUrl,
        updatedAt: card.updatedAt.toISOString(),
        href: workCardHref(card.projectId, card.number),
        ...(card.source === 'fleet' && card.fleetIssue !== null
          ? {
              fleet: {
                issue: card.fleetIssue,
                slot: card.fleetSlot,
                stage:
                  card.fleetStage !== null && isFleetStage(card.fleetStage)
                    ? card.fleetStage
                    : null,
                slotGone: card.fleetSlotGone,
              },
            }
          : {}),
      },
    }));
  }

  private async tasks(
    user: AuthUser,
    query: WorkQuery,
    search: WorkSearch | null,
    after: Keyset | null,
  ): Promise<Row[]> {
    if (query.source && query.source !== 'plan') return [];
    // Plan tasks never enter the Inbox (D2).
    if (query.status === 'inbox') return [];
    const tasks: Prisma.PlanTaskWhereInput[] = [];
    if (query.kind) tasks.push({ kind: query.kind });
    if (after) tasks.push({ updatedAt: { lte: after.at } });
    if (search) {
      const or: Prisma.PlanTaskWhereInput[] = [
        { title: { contains: search.text, mode: 'insensitive' } },
      ];
      if (search.taskKey !== null) or.push({ key: search.taskKey });
      if (search.issueNumber !== null) {
        or.push({ issueNumber: search.issueNumber });
      }
      tasks.push({ OR: or });
    }
    const rows = await loadWorkTasks(this.prisma, user.id, {
      plans: {
        project: this.access.visibleWhere(user),
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.planId ? { id: query.planId } : {}),
      },
      tasks,
    });
    return rows.flatMap(({ plan, task, issue }) => {
      const status = workStatusOfPlanTask(
        task.status,
        issue?.liveStatus ?? null,
      );
      if (query.status && query.status !== status) return [];
      return [
        {
          key: { at: task.updatedAt, id: task.id },
          item: {
            source: 'plan',
            projectId: plan.projectId,
            projectName: plan.projectName,
            planId: plan.id,
            planTitle: plan.title,
            taskId: task.id,
            key: task.key,
            title: task.title,
            kind: task.kind,
            status,
            nativeStatus: issue?.liveStatus ?? task.status,
            issue,
            updatedAt: task.updatedAt.toISOString(),
            href: workPlanTaskHref(plan.projectId, plan.id, task.key),
          },
        },
      ];
    });
  }
}
