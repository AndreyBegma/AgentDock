import {
  PLANNER_QUESTION_MAX,
  type PlanAnswer,
  type PlanQuestion,
  withRecommendations,
} from '@agentdock/shared';
import { isAnswered, type RoundAnswers, toAnswers } from './answers';

/**
 * The one-question-at-a-time round (#337 D3): question *k of n*, Previous /
 * Next, a dot per question, Send answers — and Enough — generate, which
 * sends the round as it stands with every unanswered question taking its
 * recommendation.
 */

export interface StepDot {
  index: number;
  questionId: string;
  answered: boolean;
  current: boolean;
}

/** The step the stepper shows, kept inside the round. */
export const clampStep = (step: number, count: number): number =>
  Math.min(Math.max(step, 0), Math.max(count - 1, 0));

/** "Question 2 of 3". */
export const stepLabel = (step: number, count: number): string =>
  `Question ${clampStep(step, count) + 1} of ${count}`;

export const stepDots = (
  questions: readonly PlanQuestion[],
  round: RoundAnswers,
  step: number,
): StepDot[] =>
  questions.map((q, index) => ({
    index,
    questionId: q.id,
    answered: isAnswered(round[q.id]),
    current: index === clampStep(step, questions.length),
  }));

/** A dot's accessible name: "Question 2, answered". */
export const dotLabel = (dot: StepDot): string =>
  `Question ${dot.index + 1}, ${dot.answered ? 'answered' : 'not answered'}`;

/**
 * **Enough — generate** (D3): the answers given, and every unanswered
 * question as its recommendation — what the API stores for the turn that
 * must write the card. An empty round (generate before any question)
 * sends none.
 */
export const generateAnswers = (
  round: RoundAnswers,
  questions: readonly PlanQuestion[],
): PlanAnswer[] => withRecommendations(questions, toAnswers(round, questions));

/** Why Enough — generate cannot go yet, or null: only an over-long answer stops it. */
export const generateProblem = (
  round: RoundAnswers,
  questions: readonly PlanQuestion[],
): string | null =>
  toAnswers(round, questions).some(
    (a) => (a.text?.length ?? 0) > PLANNER_QUESTION_MAX,
  )
    ? `An answer is longer than ${PLANNER_QUESTION_MAX} characters.`
    : null;
