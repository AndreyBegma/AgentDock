import {
  type ConfirmSplitCard,
  type ConfirmSplitRequest,
  type ConfirmSplitResponse,
  type ConfirmStackRequest,
  type CreatePlanCardsResponse,
  cardLabel,
  PLANNER_ERROR,
  type PlanQuestion,
} from '@nautelle/shared';
import { Injectable } from '@nestjs/common';
import type { Plan, PlanTask } from '@prisma/client';
import { BoardPlanCards } from '../board/board-plan-cards';
import { PrismaService } from '../database/prisma.service';
import type { PlanActor } from './plan.service';
import {
  isPlainTitle,
  PlanCandidatesService,
  toCandidateView,
} from './plan-candidates.service';
import { intakeSplit } from './plan-intake';
import { questionsOf } from './plan-mapper';
import { findCycle } from './plan-send';
import { PlanStore } from './plan-store';
import { plannerError } from './planner-error';

const notReady = (message: string) =>
  plannerError(409, PLANNER_ERROR.notSendable, message);

const openQuestion = (q: PlanQuestion): string =>
  `- ${q.title}: ${q.question} Default taken: ${q.recommendation.text}`;

/**
 * #337 D6, D7: a task's card body — its written document, the agreed
 * specification; else the D6 sections from what the plan knows of it.
 */
export const taskCardBody = (task: {
  summary: string;
  document: string | null;
  questions: readonly PlanQuestion[];
}): string =>
  task.document?.trim()
    ? task.document
    : [
        '## What to do',
        '',
        task.summary,
        '',
        '## Acceptance criteria',
        '',
        '- [ ] To be agreed before Run.',
        '',
        '## Out of scope',
        '',
        'None.',
        '',
        '## Open questions',
        '',
        task.questions.length > 0
          ? task.questions.map(openQuestion).join('\n')
          : 'None.',
      ].join('\n');

/**
 * Create cards (#337 D7): one To Do card per approved task of the plan's
 * current version, in task order, with Depends-on links mirroring the task
 * graph. Once per plan — the plan is `done` after it — and the alternative to
 * Send to fleet, never both.
 */
@Injectable()
export class PlanCardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: PlanStore,
    private readonly planCards: BoardPlanCards,
    private readonly candidates: PlanCandidatesService,
  ) {}

  async create(plan: Plan, actor: PlanActor): Promise<CreatePlanCardsResponse> {
    if (plan.mode === 'card') {
      throw plannerError(
        409,
        PLANNER_ERROR.wrongMode,
        'A card intake makes its card itself',
      );
    }
    // #590: a discussion's cards come through New work only.
    if (plan.mode === 'discuss') {
      throw plannerError(
        409,
        PLANNER_ERROR.wrongMode,
        'A discussion makes no cards; Make a card opens New work',
      );
    }
    if (plan.status === 'done') throw this.cardsExist();
    this.store.assertOpen(plan);
    if (plan.status !== 'reviewing') {
      throw notReady('The plan is not decomposed yet');
    }
    const active = await this.prisma.planTurn.count({
      where: { planId: plan.id, phase: { in: ['queued', 'running'] } },
    });
    if (active > 0) {
      throw plannerError(
        409,
        PLANNER_ERROR.turnInProgress,
        'A turn of this plan is queued or running',
      );
    }
    const tasks = await this.store.currentTasks(this.prisma, plan);
    if (tasks.some((t) => t.cardId !== null)) throw this.cardsExist();
    const talking = tasks.filter((t) => t.status === 'needs_talk');
    if (talking.length > 0) {
      throw notReady(
        `Tasks still need a conversation: ${talking.map((t) => t.key).join(', ')}`,
      );
    }
    const chosen = tasks.filter((t) => t.status === 'approved');
    if (chosen.length === 0) throw notReady('No task is approved');
    const index = new Map(chosen.map((t, i) => [t.key, i]));
    for (const t of chosen) {
      const missing = t.dependsOn.filter((d) => !index.has(d));
      if (missing.length > 0) {
        throw notReady(
          `Task ${t.key} depends on ${missing.join(', ')}, which is not approved`,
        );
      }
    }
    const cycle = findCycle(
      chosen.map((t) => ({ key: t.key, dependsOn: t.dependsOn })),
    );
    if (cycle) {
      throw plannerError(
        409,
        PLANNER_ERROR.dependencyCycle,
        `dependsOn has a cycle: ${cycle.join(' → ')}`,
      );
    }

    const cards = await this.prisma.$transaction(async (tx) => {
      // Serializes with turns and a second Create cards of the same plan.
      await tx.$queryRaw`SELECT id FROM plans WHERE id = ${plan.id} FOR UPDATE`;
      const fresh = await tx.plan.findUniqueOrThrow({ where: { id: plan.id } });
      const made = await tx.planTask.count({
        where: {
          planId: plan.id,
          planVersion: plan.version,
          cardId: { not: null },
        },
      });
      if (fresh.status !== 'reviewing' || made > 0) throw this.cardsExist();
      const created = await this.planCards.create(tx, {
        projectId: plan.projectId,
        planId: plan.id,
        authorId: actor.userId,
        drafts: chosen.map((t) => ({
          title: t.title,
          kind: t.kind,
          body: taskCardBody({ ...t, questions: questionsOf(t.questions) }),
        })),
        links: chosen.flatMap((t, i) =>
          t.dependsOn.map((d) => [i, index.get(d) as number] as const),
        ),
      });
      for (const [i, task] of chosen.entries()) {
        await tx.planTask.update({
          where: { id: task.id },
          data: { cardId: created[i].id },
        });
      }
      await tx.plan.update({
        where: { id: plan.id },
        data: { status: 'done' },
      });
      return created;
    });
    await this.planCards.announce(cards, actor);
    this.store.publish(plan.projectId, plan.id);
    return {
      cards: chosen.map((task: PlanTask, i) => ({
        taskKey: task.key,
        number: cards[i].number,
        label: cardLabel(cards[i].number),
      })),
    };
  }

  /**
   * #409: Confirm a split — the cards the person kept, in their order, with
   * the title and kind they left and the model's body. #480 (ADR-0044): with
   * `stack`, in stage order, the stack's title, body, design switch and
   * stages beside them, whichever the intake proposed. #592 (ADR-0058): they
   * become candidates, not cards — the person accepts or rejects each in
   * Drafts, and the intake is `reviewing` until none is pending.
   */
  async confirmSplit(
    plan: Plan,
    request: ConfirmSplitRequest,
  ): Promise<ConfirmSplitResponse> {
    if (plan.mode !== 'card') {
      throw plannerError(
        409,
        PLANNER_ERROR.wrongMode,
        'Only a New work intake proposes a split',
      );
    }
    if (plan.status === 'done') throw this.cardsExist();
    this.store.assertOpen(plan);
    const seen = new Set<number>();
    for (const card of request.cards) {
      if (seen.has(card.index)) {
        throw plannerError(
          400,
          PLANNER_ERROR.invalidArgs,
          `Card ${card.index} is listed twice`,
        );
      }
      seen.add(card.index);
      if (!isPlainTitle(card.title)) {
        throw plannerError(
          400,
          PLANNER_ERROR.invalidArgs,
          `"${card.title.trim()}" is not an English title: a card is written in English`,
        );
      }
    }
    const stack = request.stack;
    if (stack) this.checkStack(stack, seen);
    // #480: a stack's cards are made in stage order.
    const order = stack
      ? stack.stages.flatMap((stage) =>
          stage.cards.map(
            (index) =>
              request.cards.find((c) => c.index === index) as ConfirmSplitCard,
          ),
        )
      : request.cards;
    const stageOf = new Map(
      (stack?.stages ?? []).flatMap((stage, i) =>
        stage.cards.map((index) => [index, i] as const),
      ),
    );

    const made = await this.prisma.$transaction(async (tx) => {
      // Serializes with the intake's turns and a second Confirm.
      await tx.$queryRaw`SELECT id FROM plans WHERE id = ${plan.id} FOR UPDATE`;
      const fresh = await tx.plan.findUniqueOrThrow({ where: { id: plan.id } });
      if (fresh.status === 'done') throw this.cardsExist();
      this.store.assertOpen(fresh);
      if (fresh.status !== 'clarifying') {
        // #592: confirmed already — its candidates wait in Drafts.
        throw plannerError(
          409,
          PLANNER_ERROR.splitStale,
          'This split was confirmed already',
        );
      }
      const active = await tx.planTurn.count({
        where: { planId: plan.id, phase: { in: ['queued', 'running'] } },
      });
      if (active > 0) {
        throw plannerError(
          409,
          PLANNER_ERROR.turnInProgress,
          'A turn of this intake is queued or running',
        );
      }
      const open = await intakeSplit(tx, plan.id);
      if (!open || open.turnId !== request.turnId) {
        throw plannerError(
          409,
          PLANNER_ERROR.splitStale,
          'This split is no longer the one the intake proposes',
        );
      }
      const drafts = order.map((kept) => {
        const proposed = open.split.cards[kept.index];
        if (!proposed) {
          throw plannerError(
            400,
            PLANNER_ERROR.invalidArgs,
            `The split has no card ${kept.index}`,
          );
        }
        return {
          title: kept.title.trim(),
          kind: kept.kind,
          body: proposed.body,
          stage: stageOf.get(kept.index),
        };
      });
      return this.candidates.write(
        tx,
        plan.id,
        drafts,
        stack
          ? {
              title: stack.title.trim(),
              body: stack.body.trim(),
              design: stack.design,
              stages: stack.stages.map((stage) => stage.title.trim()),
            }
          : null,
      );
    });
    this.store.publish(plan.projectId, plan.id);
    return { candidates: made.map(toCandidateView) };
  }

  /**
   * #480: a confirmed stack names every kept card in exactly one stage, has
   * no empty stage, and is English like its cards.
   */
  private checkStack(stack: ConfirmStackRequest, kept: ReadonlySet<number>) {
    const invalid = (message: string) =>
      plannerError(400, PLANNER_ERROR.invalidArgs, message);
    const placed = new Set<number>();
    for (const [i, stage] of stack.stages.entries()) {
      if (stage.cards.length === 0) throw invalid(`Stage ${i + 1} is empty`);
      if (!isPlainTitle(stage.title)) {
        throw invalid(`Stage ${i + 1}'s title is not English`);
      }
      for (const index of stage.cards) {
        if (!kept.has(index)) {
          throw invalid(
            `Stage ${i + 1} names card ${index}, which is not kept`,
          );
        }
        if (placed.has(index)) {
          throw invalid(`Card ${index} is in two stages`);
        }
        placed.add(index);
      }
    }
    if (placed.size !== kept.size) {
      throw invalid('Every kept card belongs to one stage of the stack');
    }
    if (!stack.title.trim() || !isPlainTitle(stack.title)) {
      throw invalid(
        `"${stack.title.trim()}" is not an English title: a stack is written in English`,
      );
    }
  }

  private cardsExist() {
    return plannerError(
      409,
      PLANNER_ERROR.cardsExist,
      "This plan's cards exist already",
    );
  }
}
