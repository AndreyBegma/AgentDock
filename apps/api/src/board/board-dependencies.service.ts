import {
  BOARD_ERROR,
  type CardDependenciesView,
  type CardDependencyRef,
  cardLabel,
  findDependencyCycle,
  isActiveRoundPhase,
  openDependencies,
  type Role,
} from '@nautelle/shared';
import { roleAtLeast } from '@nautelle/shared/protocol';
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

/** #636: what Run reads of a dependency to choose the card's base. */
const STACK_FACTS = {
  dependsOn: {
    select: {
      id: true,
      projectId: true,
      number: true,
      column: true,
      branch: true,
      prNumber: true,
      prState: true,
      mergedAt: true,
      prBase: true,
      rounds: {
        orderBy: { round: 'desc' },
        take: 1,
        select: { phase: true },
      },
    },
  },
} as const;

type StackFacts = Prisma.BoardCardDependencyGetPayload<{
  include: typeof STACK_FACTS;
}>['dependsOn'];

/** #636: the dependency's PR is open (or draft), not merged nor closed. */
const hasOpenPr = (dep: StackFacts): boolean =>
  dep.prNumber !== null &&
  dep.mergedAt === null &&
  dep.prState !== 'merged' &&
  dep.prState !== 'closed';

/**
 * #636: the dependency's work is in the project base — its PR merged into
 * the base (not into a branch it was itself stacked on), or it was accepted
 * with no open PR left.
 */
const landed = (dep: StackFacts): boolean =>
  dep.mergedAt !== null
    ? dep.prBase === null
    : dep.column === 'completed' && !hasOpenPr(dep);

/**
 * #636: the branch a card is cut from and its PR goes into, when it is not
 * the project base: its one unmerged dependency's.
 */
export interface StackedBase {
  branch: string;
  cardId: string;
  number: number;
}

/**
 * Card dependencies (#337 D8): `cardId` runs after `dependsOnId`, both of one
 * project, the graph acyclic. Run refuses while one is open — not in
 * Finished or Completed — with no override (`dependency_open`, #638);
 * moving and Accept never look. #636: a card with one unmerged dependency
 * that has an open PR is stacked on its branch.
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
   * Run's check (D8, #638 ADR-0065, #636 ADR-0064) and the base it
   * chooses. There is no override. First, a dependency not in Finished or
   * Completed refuses the Run with `dependency_open`, naming the open ones.
   * Then, among the dependencies not landed in the base:
   * - none: the project base (`null`);
   * - one with a pushed branch and an open PR from a finished round: that
   *   branch — the card is stacked on it;
   * - one without: `dependency_open`;
   * - two or more: `dependencies_unmerged` — a card branches from one
   *   dependency only, so it waits until they are merged.
   */
  async assertRunnable(cardId: string): Promise<StackedBase | null> {
    let rows = await this.stackFacts(cardId);
    // #709: a dependency's PR the board holds as open may have merged or
    // closed on GitHub, unseen by the PR poll — it is read live before the
    // card is stacked on its branch.
    // #722: one merged into a dependency branch may have been retargeted onto
    // the base by hand first — GitHub's base counts, not the stored one.
    const live = rows.filter(
      (r) =>
        !landed(r.dependsOn) &&
        (hasOpenPr(r.dependsOn) || r.dependsOn.mergedAt !== null),
    );
    if (live.length > 0) {
      const project = await this.work.project(live[0].dependsOn.projectId);
      for (const { dependsOn } of live) {
        if (dependsOn.mergedAt !== null) {
          await this.work.refreshMergedBase(project, dependsOn);
        } else {
          await this.work.dependencyMergedAt(project, dependsOn.id);
        }
      }
      rows = await this.stackFacts(cardId);
    }
    const open = openDependencies(
      rows.map((r) => refOf(r.dependsOn)).sort(byNumber),
    );
    if (open.length > 0) {
      const names = open.map((d) => d.label).join(', ');
      throw boardError(
        409,
        BOARD_ERROR.dependencyOpen,
        `Waits for ${names}: no ready pull request yet`,
        { dependencies: open },
      );
    }
    const pending = rows
      .map((r) => r.dependsOn)
      .filter((d) => !landed(d))
      .sort(byNumber);
    const [only] = pending;
    if (!only) return null;
    if (pending.length > 1) {
      const names = pending.map((d) => cardLabel(d.number)).join(', ');
      throw boardError(
        409,
        BOARD_ERROR.dependenciesUnmerged,
        `${names} are not merged yet; a card branches from one dependency only`,
        { dependencies: pending.map(refOf) },
      );
    }
    // #709: a dependency whose PR closed unmerged is no branch to build on;
    // the card starts from the base.
    if (only.mergedAt === null && only.prState === 'closed') return null;
    if (
      hasOpenPr(only) &&
      only.branch !== null &&
      !isActiveRoundPhase(only.rounds[0]?.phase)
    ) {
      return { branch: only.branch, cardId: only.id, number: only.number };
    }
    throw boardError(
      409,
      BOARD_ERROR.dependencyOpen,
      `${cardLabel(only.number)} is not completed yet and has no open pull request to build on`,
      { dependencies: [refOf(only)] },
    );
  }

  private stackFacts(cardId: string) {
    return this.prisma.boardCardDependency.findMany({
      where: { cardId },
      include: STACK_FACTS,
    });
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
