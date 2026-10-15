import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  type IntakeTurnState,
  intakeOutputSchema,
  isIntakeCard,
  type PlanQuestion,
} from '@agentdock/shared';
import type { Prisma } from '@prisma/client';
import { inputOf } from './plan-mapper';

type Db = Pick<Prisma.TransactionClient, 'planTurn'>;

/**
 * The card intake (#337 D1–D6): a `card` plan whose every turn is `intake` —
 * a question round, or the card. What the turn service, the prompt and the
 * projector share about it.
 */

/**
 * The card-mode instructions (#337 "API"), authored next to the default
 * instructions and resolved through the package like them, so the repository
 * and the API image read the same file.
 */
export const CARD_INSTRUCTIONS_PATH = resolve(
  dirname(require.resolve('@agentdock/shared')),
  '../src/planner/card-instructions.md',
);

let cardInstructions: string | null = null;

export const readCardInstructions = (): string => {
  cardInstructions ??= readFileSync(CARD_INSTRUCTIONS_PATH, 'utf8');
  return cardInstructions;
};

/** A stored intake output, read back; one that no longer parses is none. */
const intakeOf = (output: Prisma.JsonValue) => {
  const parsed = intakeOutputSchema.safeParse(output);
  return parsed.success ? parsed.data : null;
};

/**
 * The round open now: the last succeeded intake turn's questions, unless it
 * wrote the card. A failed turn opened none and leaves the last one open.
 */
export const intakeRound = async (
  db: Db,
  planId: string,
): Promise<PlanQuestion[]> => {
  const last = await db.planTurn.findFirst({
    where: { planId, action: 'intake', phase: 'succeeded' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { output: true },
  });
  const output = last ? intakeOf(last.output) : null;
  return output && !isIntakeCard(output) ? output.questions : [];
};

/** The contract's "not English" refusal, as a failed turn stores it. */
export const NOT_ENGLISH_ERROR = 'contract_violation: not_english';

/**
 * What decides whether the turn `turnId` may still ask (D4), and whether the
 * one re-ask of a non-English card is over (spec "Risks"): rounds opened by
 * the succeeded turns before it, its own Enough — generate, and a
 * `not_english` failure since the last success.
 */
export const intakeTurnState = async (
  db: Db,
  planId: string,
  turn: { id: string; input: Prisma.JsonValue; createdAt: Date },
): Promise<IntakeTurnState> => {
  const earlier = await db.planTurn.findMany({
    where: {
      planId,
      action: 'intake',
      id: { not: turn.id },
      createdAt: { lte: turn.createdAt },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { phase: true, output: true, error: true },
  });
  let roundsAsked = 0;
  let notEnglish = false;
  for (const t of earlier) {
    if (t.phase === 'succeeded') {
      const output = intakeOf(t.output);
      if (output && !isIntakeCard(output)) roundsAsked += 1;
      notEnglish = false;
    } else if (t.phase === 'failed' && t.error?.startsWith(NOT_ENGLISH_ERROR)) {
      notEnglish = true;
    }
  }
  return {
    roundsAsked,
    generate: inputOf(turn.input).generate === true,
    acceptNonEnglish: notEnglish,
  };
};

/** #337 D10: the first runner release that places attachments in a plan turn. */
export const PLAN_TURN_ATTACHMENTS_MIN_RUNNER = '0.9.2';

const parts = (version: string): number[] | null => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? match.slice(1, 4).map(Number) : null;
};

/**
 * Whether a runner of `version` (its hello's `runnerVersion`) takes
 * `plan.turn`'s `attachments`. An unknown version is an older runner: its
 * strict schema would refuse the field and fail the turn.
 */
export const runnerTakesPlanAttachments = (version: string | null): boolean => {
  const have = version ? parts(version) : null;
  const need = parts(PLAN_TURN_ATTACHMENTS_MIN_RUNNER) as number[];
  if (!have) return false;
  for (let i = 0; i < 3; i += 1) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
};
