import {
  type Role,
  type TextFieldView,
  type TextNormalizationsResponse,
  type TextOwnerType,
  textFieldsSchema,
  textFieldView,
} from '@agentdock/shared';
import { roleAtLeast } from '@agentdock/shared/protocol';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { readablePlan } from '../planner/plan-access';
import { ownerOfRow } from './text-columns';

const notFound = () => new NotFoundException('Not found');

/**
 * What a reader sees of normalization (issue #271 D14, "API"): the newest
 * request's view of every (owner, field) of a card or a plan. Readable
 * exactly by those who read the owner — project members for a card (an
 * Inbox card only for operators, #244 D8), the plan rule for a plan (spec
 * 172 D12). A hidden owner is 404, as if absent.
 */
@Injectable()
export class TextViews {
  constructor(private readonly prisma: PrismaService) {}

  async card(
    projectId: string,
    cardId: string,
    role: Role,
  ): Promise<TextNormalizationsResponse> {
    const card = await this.prisma.boardCard.findFirst({
      where: { id: cardId, projectId },
      select: { id: true, column: true },
    });
    if (!card || (card.column === 'inbox' && !roleAtLeast(role, 'operator'))) {
      throw notFound();
    }
    return this.views({
      OR: [
        { cardId: card.id },
        { round: { cardId: card.id } },
        { comment: { design: { cardId: card.id } } },
      ],
    });
  }

  async plan(
    projectId: string,
    userId: string,
    planId: string,
  ): Promise<TextNormalizationsResponse> {
    const plan = await this.prisma.plan.findFirst({
      where: readablePlan(userId, projectId, planId),
      select: { id: true },
    });
    if (!plan) throw notFound();
    return this.views({
      OR: [
        { planId: plan.id },
        { task: { planId: plan.id } },
        { turn: { planId: plan.id } },
        { comment: { design: { planId: plan.id } } },
      ],
    });
  }

  /**
   * The request `id` of the project, if `userId` may read its owner (for
   * Retry); else 404.
   */
  async readable(
    projectId: string,
    userId: string,
    id: string,
  ): Promise<{ id: string }> {
    const row = await this.prisma.textNormalization.findFirst({
      where: { id, projectId },
      select: {
        id: true,
        planId: true,
        task: { select: { planId: true } },
        turn: { select: { planId: true } },
        comment: { select: { design: { select: { planId: true } } } },
      },
    });
    if (!row) throw notFound();
    const planId =
      row.planId ??
      row.task?.planId ??
      row.turn?.planId ??
      row.comment?.design.planId ??
      null;
    if (planId !== null) {
      const plan = await this.prisma.plan.findFirst({
        where: readablePlan(userId, projectId, planId),
        select: { id: true },
      });
      if (!plan) throw notFound();
    }
    return { id: row.id };
  }

  /** The newest request that holds each (owner, field); one never sent is skipped. */
  private async views(
    where: Prisma.TextNormalizationWhereInput,
  ): Promise<TextNormalizationsResponse> {
    const rows = await this.prisma.textNormalization.findMany({
      where: { AND: [where, { status: { not: 'superseded' } }] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const seen = new Set<string>();
    const fields: TextFieldView[] = [];
    for (const row of rows) {
      const owner = ownerOfRow(row);
      const parsed = textFieldsSchema.safeParse(row.fields);
      if (!parsed.success) continue;
      for (const field of parsed.data) {
        const key = viewKey(owner.ownerType, owner.ownerId, field.field);
        if (seen.has(key)) continue;
        seen.add(key);
        fields.push(textFieldView(owner, row, field));
      }
    }
    return { fields };
  }
}

const viewKey = (ownerType: TextOwnerType, ownerId: string, field: string) =>
  `${ownerType}\u0000${ownerId}\u0000${field}`;
