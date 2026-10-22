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
import {
  afterKeyset,
  KEYSET_ORDER,
  mergeKeysetPage,
  type SourceSlice,
} from './keyset-page';
import { unknownCursor } from './work-error';
import { pageWorkTasks, type WorkTask } from './work-tasks';

type Slice = SourceSlice<WorkItem>;

const NONE: Slice = { rows: [], horizon: null };

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

/**
 * `GET /work` (issue #270 D10, D11): board cards, plan tasks and — for the
 * projects the caller operates — Inbox suggestions, across the projects they
 * can see, in one keyset `(updatedAt, id)` descending. Each source reads a
 * page plus one in that order (L-25) and the two are merged by cursor here; a
 * plan task's status is derived after the join (as `GET /tasks`), so a status
 * filter reads the tasks on in bounded batches (`pageWorkTasks`).
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
    const { items, next } = mergeKeysetPage([cards, tasks], WORK_PAGE_SIZE);
    return { items, nextCursor: next ? encodeKeyset(next) : null };
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
  ): Promise<Slice> {
    // A plan filter or `rejected` names plan tasks only (D10).
    if (
      query.source === 'plan' ||
      query.planId ||
      query.status === 'rejected'
    ) {
      return NONE;
    }
    const wanted = BOARD_COLUMNS.filter(
      (c: BoardColumn) =>
        (query.source === 'inbox'
          ? c === 'inbox'
          : (query.source !== 'card' && query.source !== 'fleet') ||
            c !== 'inbox') &&
        (!query.status || query.status === c),
    );
    if (wanted.length === 0) return NONE;
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
    if (columns.length === 0) return NONE;

    const and: Prisma.BoardCardWhereInput[] = [
      { project: this.access.visibleWhere(user) },
      { OR: columns },
    ];
    if (query.projectId) and.push({ projectId: query.projectId });
    if (query.kind) and.push({ kind: query.kind });
    // #388: `fleet` is its own source; `card` and `inbox` no longer include it.
    if (query.source === 'fleet') and.push({ source: 'fleet' });
    else if (query.source) and.push({ source: { not: 'fleet' } });
    if (after) and.push(afterKeyset(after));
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
      orderBy: KEYSET_ORDER,
      take: WORK_PAGE_SIZE + 1,
      include: {
        project: { select: { displayName: true } },
        rounds: {
          orderBy: { round: 'desc' },
          take: 1,
          select: { phase: true },
        },
      },
    });
    const last = cards.at(-1);
    const rows = cards.map((card) => ({
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
    return {
      rows,
      horizon:
        cards.length > WORK_PAGE_SIZE && last
          ? { at: last.updatedAt, id: last.id }
          : null,
    };
  }

  private async tasks(
    user: AuthUser,
    query: WorkQuery,
    search: WorkSearch | null,
    after: Keyset | null,
  ): Promise<Slice> {
    if (query.source && query.source !== 'plan') return NONE;
    // Plan tasks never enter the Inbox (D2).
    if (query.status === 'inbox') return NONE;
    const tasks: Prisma.PlanTaskWhereInput[] = [];
    if (query.kind) tasks.push({ kind: query.kind });
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
    const statusOf = ({ task, issue }: WorkTask) =>
      workStatusOfPlanTask(task.status, issue?.liveStatus ?? null);
    const slice = await pageWorkTasks(this.prisma, user.id, {
      plans: {
        project: this.access.visibleWhere(user),
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.planId ? { id: query.planId } : {}),
      },
      tasks,
      after,
      size: WORK_PAGE_SIZE,
      ...(query.status
        ? { keep: (r: WorkTask) => statusOf(r) === query.status }
        : {}),
    });
    return {
      horizon: slice.horizon,
      rows: slice.rows.map(({ key, item: row }) => {
        const { plan, task, issue } = row;
        return {
          key,
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
            status: statusOf(row),
            nativeStatus: issue?.liveStatus ?? task.status,
            issue,
            updatedAt: task.updatedAt.toISOString(),
            href: workPlanTaskHref(plan.projectId, plan.id, task.key),
          },
        };
      }),
    };
  }
}
