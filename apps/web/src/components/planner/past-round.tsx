'use client';

import { formatDate } from '../../lib/format';
import {
  answerText,
  type PastRound as Round,
  tookRecommendation,
} from '../../lib/planner/rounds';
import { AnsweredQuestionCard } from './question-card';

/**
 * An earlier round of question cards, read-only (#184): what the planner
 * asked and what came back. Only the open round below it is interactive.
 */
export function PastRound({ round, number }: { round: Round; number: number }) {
  const { answeredBy } = round;
  const headingId = `round-${round.openedBy.id}-${number}`;
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-3"
    >
      <h3
        id={headingId}
        className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold text-ink"
      >
        Round {number}
        <span className="text-xs font-normal text-ink-3">
          {answeredBy ? (
            <>
              answered by {answeredBy.author.name} ·{' '}
              <time dateTime={answeredBy.createdAt}>
                {formatDate(answeredBy.createdAt, 'datetime')}
              </time>
            </>
          ) : (
            'replaced before it was answered'
          )}
        </span>
      </h3>
      {round.questions.map((q, i) => {
        const answer = round.answers[q.id];
        return (
          <AnsweredQuestionCard
            key={q.id}
            question={q}
            index={i + 1}
            idPrefix={headingId}
            answer={answerText(q, answer)}
            recommended={tookRecommendation(q, answer)}
            answered={answeredBy !== null}
          />
        );
      })}
    </section>
  );
}
