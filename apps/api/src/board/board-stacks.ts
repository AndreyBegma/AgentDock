import {
  type AddStackCardRequest,
  BOARD_ERROR,
  type BoardColumn,
  type BoardStackDetail,
  type BoardStackView,
  type CardStackRef,
  type CreateBoardStackRequest,
  cardLabel,
  currentStage,
  findDependencyCycle,
  isActiveRoundPhase,
  isStackGated,
  STACK_GATE_REASON,
  type StackCardRunState,
  type StackRunPause,
  type StackRunView,
  stackColumn,
  stackLabel,
  stageLinks,
  type TaskDesignSummary,
  type UpdateBoardStackRequest,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import { type BoardStack, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import {
  defaultSkillsOf,
  type FrameFile,
  revisionFrames,
} from '../design/design-store';
import { usageByRun } from '../history/run-usage';
import { boardError } from './board-error';
import { cardDesignSelect, prTargetOf } from './board-mapper';
import { type BoardActor, BoardWork } from './board-work';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;

/** A stage as a stack is made: its title and its cards' ids, in order. */
export interface StackStageInput {
  title: string;
  cardIds: readonly string[];
}

export interface CreateStackInput {
  projectId: string;
  planId: string | null;
  authorId: string | null;
  title: string;
  body: string;
  /** A shared design is needed: no card of the stack runs until it is approved. */
  design: boolean;
  stages: readonly StackStageInput[];
}

/** #480: what Run of a stack card needs of its stack — the prompt and the reference files. */
export interface CardStackContext {
  number: number;
  title: string;
  stage: number;
  stageTitle: string;
  stageCount: number;
  /** The approved stack design; null without one. */
  design: { variant: number; rationale: string; frames: FrameFile[] } | null;
}

const designSummary = (
  design: Prisma.TaskDesignGetPayload<typeof cardDesignSelect> | null,
): TaskDesignSummary | null =>
  design?.needed
    ? { ...design, busySince: design.busySince?.toISOString() ?? null }
    : null;

const stackNotFound = () =>
  boardError(404, BOARD_ERROR.notFound, 'Stack not found');

const refused = (message: string) =>
  boardError(409, BOARD_ERROR.stackRefused, message);

/** The sum of decimal strings; `null` when none is given. */
const sumCosts = (costs: readonly (string | null | undefined)[]) => {
  let total: Prisma.Decimal | null = null;
  for (const cost of costs) {
    if (cost === null || cost === undefined) continue;
    total = (total ?? new Prisma.Decimal(0)).plus(cost);
  }
  return total?.toFixed(6) ?? null;
};

const STACK_INCLUDE = {
  design: cardDesignSelect,
  stages: {
    orderBy: { position: 'asc' },
    include: {
      cards: {
        orderBy: [{ position: 'asc' }, { number: 'asc' }],
        select: {
          id: true,
          number: true,
          title: true,
          column: true,
          rounds: { select: { id: true, runId: true, phase: true } },
        },
      },
    },
  },
  run: {
    include: {
      cards: { select: { cardId: true, status: true, roundId: true } },
    },
  },
} as const satisfies Prisma.BoardStackInclude;

type StackRow = Prisma.BoardStackGetPayload<{ include: typeof STACK_INCLUDE }>;

/** #652: the round ids of the stack's cards that are still active. */
const activeRoundsOf = (row: StackRow): Set<string> =>
  new Set(
    row.stages.flatMap((s) =>
      s.cards.flatMap((c) =>
        c.rounds.filter((r) => isActiveRoundPhase(r.phase)).map((r) => r.id),
      ),
    ),
  );

/** #652: Run stack's state, as the face and the page show it. */
const stackRunOf = (row: StackRow): StackRunView | null => {
  const run = row.run;
  if (!run) return null;
  const active = activeRoundsOf(row);
  const numbers = new Map(
    row.stages.flatMap((s) => s.cards.map((c) => [c.id, c.number] as const)),
  );
  return {
    state: run.state,
    pause:
      run.state === 'paused' && run.pausedCode !== null && run.pausedAt
        ? {
            code: run.pausedCode as StackRunPause['code'],
            message: run.pausedMessage ?? '',
            card:
              run.pausedCardId !== null
                ? (numbers.get(run.pausedCardId) ?? null)
                : null,
            at: run.pausedAt.toISOString(),
          }
        : null,
    queued: run.cards.filter((c) => c.status === 'queued').length,
    waiting: run.cards.filter((c) => c.status === 'waiting').length,
    running: run.cards.filter(
      (c) => c.status === 'started' && c.roundId && active.has(c.roundId),
    ).length,
    startedAt: run.startedAt.toISOString(),
  };
};

/** #652: one card in the stack run; `null` when the run holds it no more. */
const cardRunOf = (
  row: StackRow,
  cardId: string,
  active: ReadonlySet<string>,
): StackCardRunState | null => {
  const run = row.run;
  if (!run) return null;
  if (run.state === 'paused' && run.pausedCardId === cardId) return 'paused';
  const entry = run.cards.find((c) => c.cardId === cardId);
  if (!entry) return null;
  if (entry.status === 'started') {
    return entry.roundId && active.has(entry.roundId) ? 'running' : null;
  }
  return entry.status;
};

/**
 * Stacks (#480, ADR-0044): a group of cards that make one larger piece of
 * work, in ordered stages, under one optional shared design. The stages are
 * written as ordinary card dependencies — every card of a stage on every
 * card of the stage before — so everything that reads dependencies applies.
 * While the stack's design is needed and not approved, no card of it runs.
 */
@Injectable()
export class BoardStacks {
  constructor(
    private readonly prisma: PrismaService,
    private readonly work: BoardWork,
    private readonly audit: AuditService,
  ) {}

  /** `S-<number>`: the project's next, under an advisory lock. */
  private async nextNumber(tx: Tx, projectId: string): Promise<number> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`board-stack-number:${projectId}`}))`;
    const last = await tx.boardStack.aggregate({
      where: { projectId },
      _max: { number: true },
    });
    return (last._max.number ?? 0) + 1;
  }

  /**
   * The stack, its stages, its cards' stages, the stage dependencies and —
   * when asked — its design row, inside the caller's transaction. The cards
   * exist already (`BoardPlanCards.create`).
   */
  async create(tx: Tx, input: CreateStackInput): Promise<BoardStack> {
    const number = await this.nextNumber(tx, input.projectId);
    const stack = await tx.boardStack.create({
      data: {
        projectId: input.projectId,
        number,
        title: input.title,
        body: input.body,
        planId: input.planId,
        createdById: input.authorId,
      },
    });
    for (const [position, stage] of input.stages.entries()) {
      const row = await tx.boardStackStage.create({
        data: { stackId: stack.id, position, title: stage.title },
      });
      await tx.boardCard.updateMany({
        where: { id: { in: [...stage.cardIds] } },
        data: { stageId: row.id },
      });
    }
    const links = stageLinks(input.stages.map((s) => s.cardIds));
    if (links.length > 0) {
      await tx.boardCardDependency.createMany({
        data: links.map(([cardId, dependsOnId]) => ({ cardId, dependsOnId })),
        skipDuplicates: true,
      });
    }
    if (input.design) {
      // A copy of the default; the design follows it until edited (#604).
      await tx.taskDesign.create({
        data: {
          stackId: stack.id,
          needed: true,
          suggested: true,
          skills: await defaultSkillsOf(tx, input.projectId),
        },
      });
    }
    return stack;
  }

  /** After commit: `stack.created` and the board's live event. */
  async announce(
    stack: BoardStack,
    cards: readonly { number: number }[],
    stages: number,
    design: boolean,
    actor: BoardActor,
  ): Promise<void> {
    await this.audit.record({
      ...actor.ctx,
      action: 'stack.created',
      target: { type: 'board_stack', id: stack.id },
      projectId: stack.projectId,
      after: {
        number: stack.number,
        title: stack.title,
        stages,
        cards: cards.map((c) => c.number),
        design,
        planId: stack.planId,
      },
      result: 'ok',
    });
    this.work.publishStack(stack.projectId, stack.id);
  }

  /**
   * `POST /board/stacks` (#588): cards a person groups by hand into a new
   * stack of one stage, with no dependencies between them — each still runs
   * on its own. The rules of `addCard` hold for every card; one card that
   * breaks them refuses the whole request and nothing is made.
   */
  async group(
    projectId: string,
    request: CreateBoardStackRequest,
    actor: BoardActor,
  ): Promise<BoardStackDetail> {
    const numbers = [...new Set(request.cards)];
    const design = request.design ?? false;
    const { stack, cards } = await this.prisma.$transaction(async (tx) => {
      const found = await tx.boardCard.findMany({
        where: { projectId, number: { in: numbers } },
        select: { id: true },
      });
      if (found.length > 0) {
        await tx.$queryRaw`SELECT id FROM board_cards WHERE id IN (${Prisma.join(found.map((c) => c.id))}) FOR UPDATE`;
      }
      const rows = await tx.boardCard.findMany({
        where: { projectId, number: { in: numbers } },
        select: {
          id: true,
          number: true,
          column: true,
          stage: { select: { stack: { select: { number: true } } } },
        },
      });
      const byNumber = new Map(rows.map((r) => [r.number, r]));
      const broken: { number: number; why: string }[] = [];
      for (const number of numbers) {
        const row = byNumber.get(number);
        const why = !row
          ? 'is not a card of this project'
          : row.stage
            ? `is in ${stackLabel(row.stage.stack.number)} already`
            : row.column === 'inbox'
              ? 'is a suggestion: it joins a stack once it is accepted'
              : null;
        if (why) broken.push({ number, why });
      }
      if (broken.length > 0) {
        throw boardError(
          409,
          BOARD_ERROR.stackRefused,
          broken.map((b) => `${cardLabel(b.number)} ${b.why}`).join('; '),
          { cards: broken.map((b) => b.number) },
        );
      }
      const ordered = numbers.flatMap((n) => byNumber.get(n) ?? []);
      const stack = await this.create(tx, {
        projectId,
        planId: null,
        authorId: actor.userId,
        title: request.title.trim(),
        body: request.body ?? '',
        design,
        stages: [{ title: '', cardIds: ordered.map((c) => c.id) }],
      });
      return { stack, cards: ordered };
    });
    await this.announce(stack, cards, 1, design, actor);
    for (const card of cards) this.work.publish(projectId, card.id);
    return this.detail(projectId, stack.number);
  }

  /** Every card's stack, as its face shows it; a card in none is absent. */
  async refsOf(
    cardIds: readonly string[],
    db: Db = this.prisma,
  ): Promise<Map<string, CardStackRef>> {
    const refs = new Map<string, CardStackRef>();
    if (cardIds.length === 0) return refs;
    const rows = await db.boardCard.findMany({
      where: { id: { in: [...cardIds] }, stageId: { not: null } },
      select: {
        id: true,
        stage: {
          select: {
            position: true,
            title: true,
            stack: {
              select: {
                number: true,
                title: true,
                design: { select: { needed: true, status: true } },
              },
            },
          },
        },
      },
    });
    for (const row of rows) {
      const stage = row.stage;
      if (!stage) continue;
      refs.set(row.id, {
        number: stage.stack.number,
        label: stackLabel(stage.stack.number),
        title: stage.stack.title,
        stage: stage.position,
        stageTitle: stage.title,
        gate: isStackGated(stage.stack.design) ? STACK_GATE_REASON : null,
      });
    }
    return refs;
  }

  /** `GET /board`'s stacks: each with the column its collapsed face sits in. */
  async views(projectId: string): Promise<BoardStackView[]> {
    const rows = await this.prisma.boardStack.findMany({
      where: { projectId },
      include: STACK_INCLUDE,
      orderBy: { number: 'asc' },
    });
    const costs = await this.costs(rows);
    return rows.map((row) => this.viewOf(row, costs));
  }

  /** `GET /board/stacks/:number`. */
  async detail(projectId: string, number: number): Promise<BoardStackDetail> {
    const row = await this.row(projectId, number);
    const cardIds = row.stages.flatMap((s) => s.cards.map((c) => c.id));
    const [costs, cards, deps] = await Promise.all([
      this.costs([row]),
      this.prisma.boardCard.findMany({
        where: { id: { in: cardIds } },
        include: {
          rounds: { orderBy: { round: 'desc' }, take: 1 },
          design: cardDesignSelect,
          prBaseCard: { select: { number: true } },
        },
      }),
      this.prisma.boardCardDependency.findMany({
        where: { cardId: { in: cardIds }, dependsOnId: { in: cardIds } },
        select: {
          cardId: true,
          dependsOn: { select: { number: true } },
        },
      }),
    ]);
    const byId = new Map(cards.map((c) => [c.id, c]));
    const view = this.viewOf(row, costs);
    const active = activeRoundsOf(row);
    const { base } = await this.work.project(projectId);
    const started = await this.prisma.boardCardRound.count({
      where: { cardId: { in: cardIds } },
    });
    return {
      ...view,
      body: row.body,
      planId: row.planId,
      started: started > 0,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      design: designSummary(row.design),
      stages: row.stages.map((stage) => ({
        position: stage.position,
        title: stage.title,
        cards: stage.cards.map((c) => {
          const card = byId.get(c.id);
          const round = card?.rounds[0];
          return {
            number: c.number,
            label: cardLabel(c.number),
            title: c.title,
            column: c.column,
            round: round
              ? {
                  round: round.round,
                  phase: round.phase,
                  finishedBy: round.finishedBy,
                  waitingAt: round.waitingAt?.toISOString() ?? null,
                  backgroundAt: round.backgroundAt?.toISOString() ?? null,
                  backgroundCommand: null,
                  hooksMissing: false,
                  hooksCause: null,
                }
              : null,
            design: designSummary(card?.design ?? null),
            prNumber: card?.prNumber ?? null,
            prUrl: card?.prUrl ?? null,
            prTarget: card
              ? prTargetOf(card, card.prBaseCard?.number ?? null, base)
              : null,
            after: deps
              .filter((d) => d.cardId === c.id)
              .map((d) => d.dependsOn.number)
              .sort((a, b) => a - b),
            costUsd: sumCosts(c.rounds.map((r) => costs.get(r.runId))),
            run: cardRunOf(row, c.id, active),
          };
        }),
      })),
    };
  }

  /** `PATCH /board/stacks/:number`: the title and the description. */
  async update(
    projectId: string,
    number: number,
    dto: UpdateBoardStackRequest,
    actor: BoardActor,
  ): Promise<BoardStackDetail> {
    const row = await this.row(projectId, number);
    const data = {
      ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
      ...(dto.body !== undefined ? { body: dto.body } : {}),
    };
    await this.prisma.boardStack.update({ where: { id: row.id }, data });
    await this.audit.record({
      ...actor.ctx,
      action: 'stack.updated',
      target: { type: 'board_stack', id: row.id },
      projectId,
      before: { number, title: row.title },
      after: {
        number,
        ...(data.title !== undefined ? { title: data.title } : {}),
        body: dto.body !== undefined,
      },
      result: 'ok',
    });
    this.work.publishStack(projectId, row.id);
    return this.detail(projectId, number);
  }

  /**
   * `POST /board/stacks/:number/cards`: a card of the project that is in no
   * stack joins a stage — an existing one, or a new last one. It then waits
   * on every card of the stage before, and every card of the stage after
   * waits on it. A link that would close a cycle refuses the whole change.
   */
  async addCard(
    projectId: string,
    number: number,
    request: AddStackCardRequest,
    actor: BoardActor,
  ): Promise<BoardStackDetail> {
    const row = await this.row(projectId, number);
    const card = await this.work.card(projectId, request.card);
    if (card.stageId !== null) {
      throw refused(`${cardLabel(card.number)} is in a stack already`);
    }
    if (card.column === 'inbox') {
      throw refused('A suggestion joins a stack once it is accepted');
    }
    if (request.stage > row.stages.length) {
      throw refused(`The stack has no stage ${request.stage + 1}`);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM board_stacks WHERE id = ${row.id} FOR UPDATE`;
      const stage =
        request.stage < row.stages.length
          ? row.stages[request.stage]
          : await tx.boardStackStage.create({
              data: { stackId: row.id, position: request.stage, title: '' },
            });
      const before = row.stages[request.stage - 1]?.cards ?? [];
      const after = row.stages[request.stage + 1]?.cards ?? [];
      const links: [string, string][] = [
        ...before.map((b) => [card.id, b.id] as [string, string]),
        ...after.map((a) => [a.id, card.id] as [string, string]),
      ];
      const edges = await tx.boardCardDependency.findMany({
        where: { card: { projectId } },
        select: { cardId: true, dependsOnId: true },
      });
      for (const [cardId, dependsOnId] of links) {
        if (findDependencyCycle(edges, cardId, dependsOnId)) {
          throw boardError(
            409,
            BOARD_ERROR.dependencyCycle,
            `${cardLabel(card.number)} would close a dependency cycle in this stage`,
          );
        }
        edges.push({ cardId, dependsOnId });
      }
      await tx.boardCard.update({
        where: { id: card.id },
        data: { stageId: stage.id },
      });
      if (links.length > 0) {
        await tx.boardCardDependency.createMany({
          data: links.map(([cardId, dependsOnId]) => ({ cardId, dependsOnId })),
          skipDuplicates: true,
        });
      }
    });
    await this.changed(row, actor, { add: card.number, stage: request.stage });
    this.work.publish(projectId, card.id);
    return this.detail(projectId, number);
  }

  /**
   * `DELETE /board/stacks/:number/cards/:card`: the card leaves its stage and
   * the stage dependencies that tied it to the stages beside it. It stays on
   * the board. A stage left empty is dropped while no card of the stack has
   * run; once one has, stages no longer move.
   */
  async removeCard(
    projectId: string,
    number: number,
    cardNumber: number,
    actor: BoardActor,
  ): Promise<BoardStackDetail> {
    const row = await this.row(projectId, number);
    const index = row.stages.findIndex((s) =>
      s.cards.some((c) => c.number === cardNumber),
    );
    if (index < 0) {
      throw refused(`${cardLabel(cardNumber)} is not in ${stackLabel(number)}`);
    }
    const stage = row.stages[index];
    const card = stage.cards.find((c) => c.number === cardNumber);
    if (!card) throw refused(`${cardLabel(cardNumber)} is not in this stack`);
    const neighbours = [
      ...(row.stages[index - 1]?.cards ?? []),
      ...(row.stages[index + 1]?.cards ?? []),
    ].map((c) => c.id);
    const started =
      (await this.prisma.boardCardRound.count({
        where: {
          cardId: { in: row.stages.flatMap((s) => s.cards.map((c) => c.id)) },
        },
      })) > 0;
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM board_stacks WHERE id = ${row.id} FOR UPDATE`;
      await tx.boardCardDependency.deleteMany({
        where: {
          OR: [
            { cardId: card.id, dependsOnId: { in: neighbours } },
            { dependsOnId: card.id, cardId: { in: neighbours } },
          ],
        },
      });
      await tx.boardCard.update({
        where: { id: card.id },
        data: { stageId: null },
      });
      if (stage.cards.length === 1 && !started) {
        // The stages before and after it now meet: re-link them, then close the gap.
        const prev = row.stages[index - 1]?.cards ?? [];
        const next = row.stages[index + 1]?.cards ?? [];
        const links = stageLinks([
          prev.map((c) => c.id),
          next.map((c) => c.id),
        ]);
        if (links.length > 0) {
          await tx.boardCardDependency.createMany({
            data: links.map(([cardId, dependsOnId]) => ({
              cardId,
              dependsOnId,
            })),
            skipDuplicates: true,
          });
        }
        await tx.boardStackStage.delete({ where: { id: stage.id } });
        for (const later of row.stages.slice(index + 1)) {
          await tx.boardStackStage.update({
            where: { id: later.id },
            data: { position: later.position - 1 },
          });
        }
      }
    });
    await this.changed(row, actor, { remove: cardNumber });
    this.work.publish(projectId, card.id);
    return this.detail(projectId, number);
  }

  /**
   * ADR-0044: a card of a stack whose design is needed and not approved does
   * not run — nothing writes project code before it is — and does not draw
   * its own design, whose turn builds on the stack's approved one (#527).
   */
  async assertStackApproved(cardId: string): Promise<void> {
    const ref = (await this.refsOf([cardId])).get(cardId);
    if (!ref?.gate) return;
    throw boardError(
      409,
      BOARD_ERROR.stackDesignNotApproved,
      `${ref.label} "${ref.title}": the stack design is not approved yet`,
    );
  }

  /** What Run of a stack card carries of its stack; null for a card in none. */
  async contextOf(cardId: string): Promise<CardStackContext | null> {
    const card = await this.prisma.boardCard.findUnique({
      where: { id: cardId },
      select: {
        stage: {
          select: {
            position: true,
            title: true,
            stack: {
              select: {
                number: true,
                title: true,
                _count: { select: { stages: true } },
                design: {
                  select: {
                    needed: true,
                    status: true,
                    approvedRevision: {
                      select: { id: true, variant: true, rationale: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const stage = card?.stage;
    if (!stage) return null;
    const { stack } = stage;
    const approved =
      stack.design?.needed && stack.design.status === 'approved'
        ? stack.design.approvedRevision
        : null;
    return {
      number: stack.number,
      title: stack.title,
      stage: stage.position,
      stageTitle: stage.title,
      stageCount: stack._count.stages,
      design: approved
        ? {
            variant: approved.variant,
            rationale: approved.rationale,
            frames: await revisionFrames(this.prisma, approved.id),
          }
        : null,
    };
  }

  private async row(projectId: string, number: number): Promise<StackRow> {
    const row = await this.prisma.boardStack.findUnique({
      where: { projectId_number: { projectId, number } },
      include: STACK_INCLUDE,
    });
    if (!row) throw stackNotFound();
    return row;
  }

  private async costs(rows: readonly StackRow[]) {
    const runIds = rows.flatMap((r) =>
      r.stages.flatMap((s) =>
        s.cards.flatMap((c) => c.rounds.map((x) => x.runId)),
      ),
    );
    const usage = await usageByRun(this.prisma, runIds);
    const costs = new Map<string, string>();
    for (const [runId, u] of usage) {
      if (u.costUsd !== null) costs.set(runId, u.costUsd);
    }
    return costs;
  }

  private viewOf(
    row: StackRow,
    costs: ReadonlyMap<string, string>,
  ): BoardStackView {
    const columns: BoardColumn[] = row.stages.flatMap((s) =>
      s.cards.map((c) => c.column),
    );
    return {
      id: row.id,
      number: row.number,
      label: stackLabel(row.number),
      title: row.title,
      column: stackColumn(columns),
      accepted: columns.filter((c) => c === 'completed').length,
      total: columns.length,
      currentStage: currentStage(
        row.stages.map((s) => ({
          position: s.position,
          columns: s.cards.map((c) => c.column),
        })),
      ),
      stages: row.stages.map((s) => ({
        position: s.position,
        title: s.title,
        cards: s.cards.map((c) => c.number),
      })),
      design: designSummary(row.design),
      costUsd: sumCosts(
        row.stages.flatMap((s) =>
          s.cards.flatMap((c) => c.rounds.map((r) => costs.get(r.runId))),
        ),
      ),
      run: stackRunOf(row),
    };
  }

  private async changed(
    row: Pick<BoardStack, 'id' | 'projectId' | 'number'>,
    actor: BoardActor,
    change: Record<string, number>,
  ): Promise<void> {
    await this.audit.record({
      ...actor.ctx,
      action: 'stack.updated',
      target: { type: 'board_stack', id: row.id },
      projectId: row.projectId,
      after: { number: row.number, ...change },
      result: 'ok',
    });
    this.work.publishStack(row.projectId, row.id);
  }
}
