import {
  PROJECT_RULE_TITLE_MAX,
  TEXT_ANSWER_FIELD_PREFIX,
  type TextOwnerType,
  textAnswerField,
} from '@agentdock/shared';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service';

type Db = Prisma.TransactionClient | PrismaService;

/** One owner of normalized text (D1). */
export interface TextOwnerRef {
  ownerType: TextOwnerType;
  ownerId: string;
}

/** The owner foreign key of `text_normalizations` for each owner type. */
export const TEXT_OWNER_KEYS = {
  board_card: 'cardId',
  board_card_round: 'roundId',
  design_comment: 'commentId',
  plan: 'planId',
  plan_task: 'taskId',
  plan_turn: 'turnId',
  project_rule: 'ruleId',
} as const satisfies Record<TextOwnerType, string>;

export type TextOwnerKey = (typeof TEXT_OWNER_KEYS)[TextOwnerType];

/** The owner's `text_normalizations` foreign key, as a `create` / `where` fragment. */
export const ownerWhere = (
  owner: TextOwnerRef,
): Partial<Record<TextOwnerKey, string>> => ({
  [TEXT_OWNER_KEYS[owner.ownerType]]: owner.ownerId,
});

/** The owner of a `text_normalizations` row, from its one set key. */
export const ownerOfRow = (row: {
  ownerType: TextOwnerType;
  cardId: string | null;
  roundId: string | null;
  commentId: string | null;
  planId: string | null;
  taskId: string | null;
  turnId: string | null;
  ruleId: string | null;
}): TextOwnerRef => ({
  ownerType: row.ownerType,
  ownerId: row[TEXT_OWNER_KEYS[row.ownerType]] ?? '',
});

const TABLES: Record<TextOwnerType, string> = {
  board_card: 'board_cards',
  board_card_round: 'board_card_rounds',
  design_comment: 'design_comments',
  plan: 'plans',
  plan_task: 'plan_tasks',
  plan_turn: 'plan_turns',
  project_rule: 'project_rules',
};

/** `plan_turns.input` as far as text goes (`planTurnInputSchema`). */
interface TurnInput {
  message?: unknown;
  answers?: unknown;
  [key: string]: unknown;
}

const turnInput = (value: Prisma.JsonValue): TurnInput =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as TurnInput)
    : {};

/** The free-text fields of a turn's input: `message`, `answers.<questionId>`. */
export const turnInputFields = (
  value: Prisma.JsonValue,
): Map<string, string> => {
  const input = turnInput(value);
  const fields = new Map<string, string>();
  if (typeof input.message === 'string' && input.message !== '') {
    fields.set('message', input.message);
  }
  if (Array.isArray(input.answers)) {
    for (const answer of input.answers) {
      if (
        typeof answer === 'object' &&
        answer !== null &&
        typeof answer.questionId === 'string' &&
        typeof answer.text === 'string' &&
        answer.text !== ''
      ) {
        fields.set(textAnswerField(answer.questionId), answer.text);
      }
    }
  }
  return fields;
};

/**
 * The current text of every normalized field of an owner (D1), or `null`
 * when the owner is gone. An empty or absent field is left out.
 */
export const readOwnerText = async (
  db: Db,
  owner: TextOwnerRef,
): Promise<Map<string, string> | null> => {
  const id = owner.ownerId;
  const fields = (entries: [string, string | null][]) =>
    new Map(
      entries.filter((e): e is [string, string] => !!e[1] && e[1] !== ''),
    );
  switch (owner.ownerType) {
    case 'board_card': {
      const row = await db.boardCard.findUnique({
        where: { id },
        select: { title: true, body: true },
      });
      return row
        ? fields([
            ['title', row.title],
            ['body', row.body],
          ])
        : null;
    }
    case 'board_card_round': {
      const row = await db.boardCardRound.findUnique({
        where: { id },
        select: { feedback: true },
      });
      return row ? fields([['feedback', row.feedback]]) : null;
    }
    case 'design_comment': {
      const row = await db.designComment.findUnique({
        where: { id },
        select: { body: true },
      });
      return row ? fields([['body', row.body]]) : null;
    }
    case 'plan': {
      const row = await db.plan.findUnique({
        where: { id },
        select: { brief: true },
      });
      return row ? fields([['brief', row.brief]]) : null;
    }
    case 'plan_task': {
      const row = await db.planTask.findUnique({
        where: { id },
        select: { rewriteComment: true },
      });
      return row ? fields([['rewriteComment', row.rewriteComment]]) : null;
    }
    case 'plan_turn': {
      const row = await db.planTurn.findUnique({
        where: { id },
        select: { input: true },
      });
      return row ? turnInputFields(row.input) : null;
    }
    case 'project_rule': {
      const row = await db.projectRule.findUnique({
        where: { id },
        select: { title: true, description: true },
      });
      return row
        ? fields([
            ['title', row.title],
            ['description', row.description],
          ])
        : null;
    }
  }
};

/** Holds the owner's row until the transaction ends (D8's compare-and-set). */
export const lockOwner = async (
  tx: Prisma.TransactionClient,
  owner: TextOwnerRef,
): Promise<void> => {
  await tx.$executeRaw`SELECT 1 FROM ${Prisma.raw(`"${TABLES[owner.ownerType]}"`)} WHERE id = ${owner.ownerId} FOR UPDATE`;
};

/** Writes English text to the owner's columns; `values` holds field → text. */
export const writeOwnerText = async (
  tx: Prisma.TransactionClient,
  owner: TextOwnerRef,
  values: ReadonlyMap<string, string>,
): Promise<void> => {
  if (values.size === 0) return;
  const id = owner.ownerId;
  const value = (field: string) => values.get(field);
  switch (owner.ownerType) {
    case 'board_card':
      await tx.boardCard.update({
        where: { id },
        data: {
          ...(value('title') !== undefined ? { title: value('title') } : {}),
          ...(value('body') !== undefined ? { body: value('body') } : {}),
        },
      });
      return;
    case 'board_card_round':
      await tx.boardCardRound.update({
        where: { id },
        data: { feedback: value('feedback') },
      });
      return;
    case 'design_comment':
      await tx.designComment.update({
        where: { id },
        data: { body: value('body') },
      });
      return;
    case 'plan':
      await tx.plan.update({ where: { id }, data: { brief: value('brief') } });
      return;
    case 'plan_task':
      await tx.planTask.update({
        where: { id },
        data: { rewriteComment: value('rewriteComment') },
      });
      return;
    case 'plan_turn': {
      // D10: only the JSON paths of the applied fields change.
      const row = await tx.planTurn.findUniqueOrThrow({
        where: { id },
        select: { input: true },
      });
      const input = { ...turnInput(row.input) };
      const message = value('message');
      if (message !== undefined) input.message = message;
      if (Array.isArray(input.answers)) {
        input.answers = input.answers.map((answer: unknown) => {
          if (
            typeof answer !== 'object' ||
            answer === null ||
            typeof (answer as { questionId?: unknown }).questionId !== 'string'
          ) {
            return answer;
          }
          const text = value(
            `${TEXT_ANSWER_FIELD_PREFIX}${(answer as { questionId: string }).questionId}`,
          );
          return text === undefined ? answer : { ...answer, text };
        });
      }
      await tx.planTurn.update({
        where: { id },
        data: { input: input as Prisma.InputJsonValue },
      });
      return;
    }
    case 'project_rule': {
      // A translation may run longer than the original; the title stays in bounds.
      const title = value('title')?.slice(0, PROJECT_RULE_TITLE_MAX);
      await tx.projectRule.update({
        where: { id },
        data: {
          ...(title ? { title } : {}),
          ...(value('description') !== undefined
            ? { description: value('description') }
            : {}),
        },
      });
      return;
    }
  }
};
