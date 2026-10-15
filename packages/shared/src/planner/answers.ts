import type { PlanAnswer, PlanQuestion } from './types';

/**
 * #337 D3: a round's answers against its questions — what the answer schema
 * alone cannot say, because it needs the round. The API answers a failed
 * check with 400; the question cards use the same rules before sending.
 */

/** The options an answer picks: `optionIds`, else `optionId`, else none. */
export const answerOptionIds = (answer: PlanAnswer): string[] =>
  answer.optionIds ?? (answer.optionId !== undefined ? [answer.optionId] : []);

/**
 * The answer a question takes when the person does not give one — Enough —
 * generate sends these for the unanswered questions (D3): the recommended
 * option, else the recommendation's words.
 */
export const recommendedAnswer = (question: PlanQuestion): PlanAnswer => {
  const { optionId, text } = question.recommendation;
  return optionId !== undefined
    ? { questionId: question.id, optionId }
    : { questionId: question.id, text };
};

/**
 * `answers` with every question of `questions` it leaves unanswered filled
 * by `recommendedAnswer`, in the round's order. An answer for a question not
 * in the round is kept, for `checkRoundAnswers` to refuse.
 */
export const withRecommendations = (
  questions: readonly PlanQuestion[],
  answers: readonly PlanAnswer[],
): PlanAnswer[] => {
  const given = new Map(answers.map((a) => [a.questionId, a]));
  const inRound = new Set(questions.map((q) => q.id));
  return [
    ...questions.map((q) => given.get(q.id) ?? recommendedAnswer(q)),
    ...answers.filter((a) => !inRound.has(a.questionId)),
  ];
};

export type RoundAnswersCheck = { ok: true } | { ok: false; message: string };

/**
 * Every answer names a question of the round, once; every picked option is
 * one of that question's; a question without `multiple` takes one option at
 * most. A free answer is accepted on every question (D3).
 */
export const checkRoundAnswers = (
  questions: readonly PlanQuestion[],
  answers: readonly PlanAnswer[],
): RoundAnswersCheck => {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const seen = new Set<string>();
  for (const answer of answers) {
    const question = byId.get(answer.questionId);
    if (!question) {
      return {
        ok: false,
        message: `${answer.questionId} is not a question of this round`,
      };
    }
    if (seen.has(answer.questionId)) {
      return {
        ok: false,
        message: `${answer.questionId} is answered twice`,
      };
    }
    seen.add(answer.questionId);
    const picked = answerOptionIds(answer);
    if (picked.length > 1 && question.multiple !== true) {
      return {
        ok: false,
        message: `${answer.questionId} is single choice: pick one option`,
      };
    }
    const options = new Set(question.options.map((o) => o.id));
    const unknown = picked.find((id) => !options.has(id));
    if (unknown !== undefined) {
      return {
        ok: false,
        message: `${unknown} is not an option of ${answer.questionId}`,
      };
    }
  }
  return { ok: true };
};
