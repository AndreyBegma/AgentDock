import {
  type CreatePlanCardsResponse,
  cardLabel,
  PLANNER_ERROR,
  type PlanQuestion,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import type { Plan, PlanTask } from '@prisma/client';
import { BoardPlanCards } from '../board/board-plan-cards';
import { PrismaService } from '../database/prisma.service';
import type { PlanActor } from './plan.service';
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
  ) {}

  async create(plan: Plan, actor: PlanActor): Promise<CreatePlanCardsResponse> {
    if (plan.mode === 'card') {
      throw plannerError(
        409,
        PLANNER_ERROR.wrongMode,
        'A card intake makes its card itself',
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

  private cardsExist() {
    return plannerError(
      409,
      PLANNER_ERROR.cardsExist,
      "This plan's cards exist already",
    );
  }
}
