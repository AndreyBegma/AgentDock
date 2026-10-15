import {
  answerOptionIds,
  type PlanAnswer,
  type PlanQuestion,
  type PlanTurnView,
} from '@agentdock/shared';

/**
 * Earlier rounds of a conversation (#184), as read-only cards. A round is
 * opened by a turn's output — a task's first one by the plan's decompose or
 * revise, the next ones by its grills — and answered by the next turn of
 * its scope that succeeded.
 */
export interface PastRound {
  /** The turn whose output asked it. */
  openedBy: PlanTurnView;
  questions: PlanQuestion[];
  /** Null: a later round replaced it before anyone answered. */
  answeredBy: PlanTurnView | null;
  /** By question id; a question without one was left to its default (D6). */
  answers: Readonly<Record<string, PlanAnswer>>;
}

const byTime = (a: PlanTurnView, b: PlanTurnView) =>
  a.createdAt.localeCompare(b.createdAt);

/**
 * The past rounds of one scope (a task's key, or `null` for the plan),
 * oldest first. A round is past once a succeeded turn of its scope came
 * after it, or a later round replaced it. The last round with neither is the
 * open one — the caller renders it from the task's or the plan's questions,
 * interactive, so it is not returned here.
 */
export function pastRounds(
  turns: readonly PlanTurnView[],
  taskKey: string | null,
): PastRound[] {
  const sorted = [...turns].sort(byTime);
  const opened = sorted.flatMap((turn) =>
    // An API from before #184 sends no rounds: the turns still render.
    (turn.rounds ?? [])
      .filter((r) => r.taskKey === taskKey && r.questions.length > 0)
      .map((r) => ({ turn, questions: r.questions })),
  );
  const scoped = sorted.filter(
    (t) => t.taskKey === taskKey && t.phase === 'succeeded',
  );
  return opened.flatMap(({ turn, questions }, i) => {
    const next = opened[i + 1]?.turn;
    const answeredBy =
      scoped.find(
        (s) =>
          s.createdAt > turn.createdAt &&
          (next === undefined || s.createdAt <= next.createdAt),
      ) ?? null;
    if (answeredBy === null && next === undefined) return [];
    const answers: Record<string, PlanAnswer> = {};
    for (const a of answeredBy?.input.answers ?? []) answers[a.questionId] = a;
    return [{ openedBy: turn, questions, answeredBy, answers }];
  });
}

/** An answer in words: the option's label, then the person's own words. */
export function answerText(
  question: PlanQuestion,
  answer: PlanAnswer | undefined,
): string | null {
  if (!answer) return null;
  // #337 D3: a multiple-choice answer names each pick.
  const picks = answerOptionIds(answer).map(
    (id) => question.options.find((o) => o.id === id)?.label ?? id,
  );
  const parts = [picks.join(', '), answer.text].filter(
    (p): p is string => p !== undefined && p !== '',
  );
  return parts.length > 0 ? parts.join(' — ') : null;
}

/** Whether the answer is the planner's recommendation, as **Accept** sends it. */
export function tookRecommendation(
  question: PlanQuestion,
  answer: PlanAnswer | undefined,
): boolean {
  if (!answer) return false;
  const rec = question.recommendation;
  const picks = answerOptionIds(answer);
  return rec.optionId !== undefined
    ? picks.length === 1 &&
        picks[0] === rec.optionId &&
        answer.text === undefined
    : picks.length === 0 && answer.text === rec.text;
}
