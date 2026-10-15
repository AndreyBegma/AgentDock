import {
  checkRoundAnswers,
  PLANNER_QUESTION_MAX,
  type PlanAnswer,
  type PlanQuestion,
} from '@agentdock/shared';

/**
 * A round of question cards (D7) as the person fills it in. For each card:
 * accept the recommendation, pick another option, or answer in their own
 * words — an option and words together are allowed, as the contract allows.
 * A `multiple` question (#337 D3) takes several options as checkboxes, and
 * every question takes words. The whole round goes back as one turn.
 */

export interface CardAnswer {
  /** The pick of a single-choice question. */
  optionId?: string;
  /** #337 D3: the picks of a `multiple` question, in the question's order. */
  optionIds?: readonly string[];
  text: string;
}

export type RoundAnswers = Readonly<Record<string, CardAnswer>>;

export const EMPTY_ROUND: RoundAnswers = {};

const entry = (round: RoundAnswers, questionId: string): CardAnswer =>
  round[questionId] ?? { text: '' };

export const pickOption = (
  round: RoundAnswers,
  questionId: string,
  optionId: string,
): RoundAnswers => ({
  ...round,
  [questionId]: { ...entry(round, questionId), optionId },
});

/**
 * #337 D3: checks or unchecks one option of a `multiple` question. The picks
 * keep the question's option order; unchecking the last one leaves none.
 */
export function toggleOption(
  round: RoundAnswers,
  question: PlanQuestion,
  optionId: string,
  checked: boolean,
): RoundAnswers {
  const current = new Set(entry(round, question.id).optionIds ?? []);
  if (checked) current.add(optionId);
  else current.delete(optionId);
  const optionIds = question.options
    .map((o) => o.id)
    .filter((id) => current.has(id));
  const { text } = entry(round, question.id);
  return {
    ...round,
    [question.id]: optionIds.length > 0 ? { optionIds, text } : { text },
  };
}

export const setAnswerText = (
  round: RoundAnswers,
  questionId: string,
  text: string,
): RoundAnswers => ({
  ...round,
  [questionId]: { ...entry(round, questionId), text },
});

/** The recommendation as the answer: its option, or its words when it names none. */
export function acceptRecommendation(
  round: RoundAnswers,
  question: PlanQuestion,
): RoundAnswers {
  const { optionId, text } = question.recommendation;
  const answer: CardAnswer =
    optionId === undefined
      ? { text }
      : question.multiple === true
        ? { optionIds: [optionId], text: '' }
        : { optionId, text: '' };
  return { ...round, [question.id]: answer };
}

/** **Accept all recommendations**: every card, whatever it held. */
export const acceptAllRecommendations = (
  round: RoundAnswers,
  questions: readonly PlanQuestion[],
): RoundAnswers => questions.reduce(acceptRecommendation, round);

const pickedCount = (answer: CardAnswer): number =>
  answer.optionIds?.length ?? (answer.optionId !== undefined ? 1 : 0);

export const isAnswered = (answer: CardAnswer | undefined): boolean =>
  answer !== undefined &&
  (pickedCount(answer) > 0 || answer.text.trim() !== '');

/** Whether the card's answer is exactly the planner's recommendation. */
export function isRecommended(
  answer: CardAnswer | undefined,
  question: PlanQuestion,
): boolean {
  if (!isAnswered(answer) || answer === undefined) return false;
  const rec = question.recommendation;
  if (rec.optionId !== undefined) {
    const picked =
      answer.optionIds ?? (answer.optionId ? [answer.optionId] : []);
    return (
      picked.length === 1 &&
      picked[0] === rec.optionId &&
      answer.text.trim() === ''
    );
  }
  return pickedCount(answer) === 0 && answer.text.trim() === rec.text;
}

/**
 * The round as a turn's `answers`: answered cards only, in question order.
 * A `multiple` question's picks go as `optionIds` (#337 D3), a single
 * choice as `optionId`.
 */
export function toAnswers(
  round: RoundAnswers,
  questions: readonly PlanQuestion[],
): PlanAnswer[] {
  return questions.flatMap((q) => {
    const a = round[q.id];
    if (!isAnswered(a) || a === undefined) return [];
    const text = a.text.trim();
    const picks =
      q.multiple === true
        ? a.optionIds && a.optionIds.length > 0
          ? { optionIds: [...a.optionIds] }
          : {}
        : a.optionId !== undefined
          ? { optionId: a.optionId }
          : {};
    return [
      {
        questionId: q.id,
        ...picks,
        ...(text !== '' ? { text } : {}),
      },
    ];
  });
}

export type RoundProblem = 'empty' | 'blocking' | 'too_long' | 'invalid';

export const ROUND_PROBLEM_TEXT: Record<RoundProblem, string> = {
  empty: 'Answer at least one question, or accept the recommendations.',
  blocking: 'Answer every blocking question: it has no safe default.',
  too_long: `An answer is longer than ${PLANNER_QUESTION_MAX} characters.`,
  invalid: 'An answer does not fit its question. Pick again.',
};

/**
 * Why the round cannot be sent yet, or null. A non-blocking card may stay
 * empty — the planner takes its recommendation as the default (D6); a
 * blocking one may not. The picks are checked as the API checks them
 * (`checkRoundAnswers`).
 */
export function roundProblem(
  round: RoundAnswers,
  questions: readonly PlanQuestion[],
): RoundProblem | null {
  const answers = toAnswers(round, questions);
  if (answers.some((a) => (a.text?.length ?? 0) > PLANNER_QUESTION_MAX)) {
    return 'too_long';
  }
  if (answers.length === 0) return 'empty';
  const answered = new Set(answers.map((a) => a.questionId));
  if (questions.some((q) => q.blocking && !answered.has(q.id))) {
    return 'blocking';
  }
  if (!checkRoundAnswers(questions, answers).ok) return 'invalid';
  return null;
}

/** "2 of 3 answered". */
export function answeredText(
  round: RoundAnswers,
  questions: readonly PlanQuestion[],
): string {
  const n = questions.filter((q) => isAnswered(round[q.id])).length;
  return `${n} of ${questions.length} answered`;
}

/** The round's key: a new set of questions starts a fresh round. */
export const roundKey = (questions: readonly PlanQuestion[]): string =>
  questions.map((q) => q.id).join('|');
