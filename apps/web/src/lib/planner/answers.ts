import {
  PLANNER_QUESTION_MAX,
  type PlanAnswer,
  type PlanQuestion,
} from '@agentdock/shared';

/**
 * A round of question cards (D7) as the person fills it in. For each card:
 * accept the recommendation, pick another option, or answer in their own
 * words — an option and words together are allowed, as the contract allows.
 * The whole round goes back as one turn.
 */

export interface CardAnswer {
  optionId?: string;
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
  return {
    ...round,
    [question.id]: optionId !== undefined ? { optionId, text: '' } : { text },
  };
}

/** **Accept all recommendations**: every card, whatever it held. */
export const acceptAllRecommendations = (
  round: RoundAnswers,
  questions: readonly PlanQuestion[],
): RoundAnswers => questions.reduce(acceptRecommendation, round);

export const isAnswered = (answer: CardAnswer | undefined): boolean =>
  answer !== undefined &&
  (answer.optionId !== undefined || answer.text.trim() !== '');

/** Whether the card's answer is exactly the planner's recommendation. */
export function isRecommended(
  answer: CardAnswer | undefined,
  question: PlanQuestion,
): boolean {
  if (!isAnswered(answer) || answer === undefined) return false;
  const rec = question.recommendation;
  if (rec.optionId !== undefined) {
    return answer.optionId === rec.optionId && answer.text.trim() === '';
  }
  return answer.optionId === undefined && answer.text.trim() === rec.text;
}

/** The round as a turn's `answers`: answered cards only, in question order. */
export function toAnswers(
  round: RoundAnswers,
  questions: readonly PlanQuestion[],
): PlanAnswer[] {
  return questions.flatMap((q) => {
    const a = round[q.id];
    if (!isAnswered(a) || a === undefined) return [];
    const text = a.text.trim();
    return [
      {
        questionId: q.id,
        ...(a.optionId !== undefined ? { optionId: a.optionId } : {}),
        ...(text !== '' ? { text } : {}),
      },
    ];
  });
}

export type RoundProblem = 'empty' | 'blocking' | 'too_long';

export const ROUND_PROBLEM_TEXT: Record<RoundProblem, string> = {
  empty: 'Answer at least one question, or accept the recommendations.',
  blocking: 'Answer every blocking question: it has no safe default.',
  too_long: `An answer is longer than ${PLANNER_QUESTION_MAX} characters.`,
};

/**
 * Why the round cannot be sent yet, or null. A non-blocking card may stay
 * empty — the planner takes its recommendation as the default (D6); a
 * blocking one may not.
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
