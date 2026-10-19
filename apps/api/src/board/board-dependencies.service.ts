import {
  BOARD_ERROR,
  type CardDependenciesView,
  type CardDependencyRef,
  cardLabel,
  findDependencyCycle,
  openDependencies,
  type Role,
} from '@agentdock/shared';
import { roleAtLeast } from '@agentdock/shared/protocol';
import { Injectable } from '@nestjs/common';
import type { BoardColumn, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { boardError, cardNotFound } from './board-error';
import { type BoardActor, BoardWork } from './board-work';

type Tx = Prisma.TransactionClient;

const DEPENDS_ON = {
  dependsOn: { select: { number: true, column: true, title: true } },
} as const;

const refOf = (card: {
  number: number;
  column: BoardColumn;
}): CardDependencyRef => ({
  number: card.number,
  label: cardLabel(card.number),
  column: card.column,
});

const byNumber = (a: { number: number }, b: { number: number }) =>
  a.number - b.number;

/**
 * Card dependencies (#337 D8): `cardId` runs after `dependsOnId`, both of one
 * project, the graph acyclic. Run refuses while one is open
 * (`dependency_open`, #638); moving and Accept never look.
 */
@Injectable()
export class BoardDependencies {
  constructor(
    private readonly prisma: PrismaService,
    private readonly work: BoardWork,
    private readonly audit: AuditService,
  ) {}

  /** `GET …/dependencies`: in number order. A viewer finds no Inbox card (#244 D8). */
  async list(
    projectId: string,
    number: number,
    role: Role,
  ): Promise<CardDependenciesView> {
    const card = await this.work.card(projectId, number);
    if (card.column === 'inbox' && !roleAtLeast(role, 'operator')) {
      throw cardNotFound();
    }
    return this.viewOf(card.id);
  }

  /**
   * `POST …/dependencies`. Itself, an Inbox suggestion or a number that is no
   * card of this project is `invalid_dependency`; a link that closes a cycle
   * is `dependency_cycle`. An existing link stays as it is.
   */
  async add(
    projectId: string,
    number: number,
    dependsOn: number,
    actor: BoardActor,
  ): Promise<CardDependenciesView> {
    const card = await this.work.card(projectId, number);
    const target = await this.prisma.boardCard.findUnique({
      where: { projectId_number: { projectId, number: dependsOn } },
      select: { id: true, column: true },
    });
    if (!target || target.id === card.id || target.column === 'inbox') {
      throw boardError(
        400,
        BOARD_ERROR.invalidDependency,
        target?.id === card.id
          ? 'A card does not depend on itself'
          : `${cardLabel(dependsOn)} is no card of this board`,
      );
    }
    const added = await this.prisma.$transaction(async (tx) => {
      // One graph change of a project at a time: the cycle check reads it whole.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`board-deps:${projectId}`}))`;
      const edges = await this.edges(tx, projectId);
      if (
        edges.some((e) => e.cardId === card.id && e.dependsOnId === target.id)
      ) {
        return false;
      }
      const cycle = findDependencyCycle(edges, card.id, target.id);
      if (cycle) {
        const numbers = await this.numbersOf(tx, cycle);
        throw boardError(
          409,
          BOARD_ERROR.dependencyCycle,
          `That closes a cycle: ${cycle.map((id) => cardLabel(numbers.get(id) ?? 0)).join(' → ')}`,
        );
      }
      await tx.boardCardDependency.create({
        data: { cardId: card.id, dependsOnId: target.id },
      });
      return true;
    });
    if (added) {
      await this.changed(projectId, card.id, actor, { add: dependsOn });
    }
    return this.viewOf(card.id);
  }

  /** `DELETE …/dependencies/:dependsOn`: a link that is not there is a no-op. */
  async remove(
    projectId: string,
    number: number,
    dependsOn: number,
    actor: BoardActor,
  ): Promise<CardDependenciesView> {
    const card = await this.work.card(projectId, number);
    const { count } = await this.prisma.boardCardDependency.deleteMany({
      where: { cardId: card.id, dependsOn: { projectId, number: dependsOn } },
    });
    if (count > 0) {
      await this.changed(projectId, card.id, actor, { remove: dependsOn });
    }
    return this.viewOf(card.id);
  }

  /** The face's "after C-12" of each card, in number order; absent is none. */
  async refsOf(
    cardIds: readonly string[],
  ): Promise<Map<string, CardDependencyRef[]>> {
    const refs = new Map<string, CardDependencyRef[]>();
    if (cardIds.length === 0) return refs;
    const rows = await this.prisma.boardCardDependency.findMany({
      where: { cardId: { in: [...cardIds] } },
      include: DEPENDS_ON,
    });
    for (const row of rows.sort((a, b) => byNumber(a.dependsOn, b.dependsOn))) {
      const list = refs.get(row.cardId) ?? [];
      list.push(refOf(row.dependsOn));
      refs.set(row.cardId, list);
    }
    return refs;
  }

  /**
   * Run's check (D8, #638 ADR-0064): a dependency not in Finished or
   * Completed refuses the Run with `dependency_open`, naming the open ones.
   * There is no override.
   */
  async assertRunnable(cardId: string): Promise<void> {
    const open = openDependencies(
      (await this.refsOf([cardId])).get(cardId) ?? [],
    );
    if (open.length === 0) return;
    const names = open.map((d) => d.label).join(', ');
    throw boardError(
      409,
      BOARD_ERROR.dependencyOpen,
      `Waits for ${names}: no ready pull request yet`,
      { dependencies: open },
    );
  }

  private async viewOf(cardId: string): Promise<CardDependenciesView> {
    const rows = await this.prisma.boardCardDependency.findMany({
      where: { cardId },
      include: DEPENDS_ON,
    });
    return {
      dependsOn: rows
        .map((r) => ({ ...refOf(r.dependsOn), title: r.dependsOn.title }))
        .sort(byNumber),
    };
  }

  private edges(tx: Tx, projectId: string) {
    return tx.boardCardDependency.findMany({
      where: { card: { projectId } },
      select: { cardId: true, dependsOnId: true },
    });
  }

  private async numbersOf(tx: Tx, ids: readonly string[]) {
    const rows = await tx.boardCard.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, number: true },
    });
    return new Map(rows.map((r) => [r.id, r.number]));
  }

  private async changed(
    projectId: string,
    cardId: string,
    actor: BoardActor,
    change: { add: number } | { remove: number },
  ): Promise<void> {
    const deps = (await this.refsOf([cardId])).get(cardId) ?? [];
    await this.audit.record({
      ...actor.ctx,
      action: 'card.updated',
      target: { type: 'board_card', id: cardId },
      projectId,
      after: { dependsOn: deps.map((d) => d.number), ...change },
      result: 'ok',
    });
    this.work.publish(projectId, cardId);
  }
}
