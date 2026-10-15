'use client';

import type { PlanAnswer, PlanQuestion } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { useState } from 'react';
import {
  acceptAllRecommendations,
  acceptRecommendation,
  answeredText,
  EMPTY_ROUND,
  pickOption,
  ROUND_PROBLEM_TEXT,
  type RoundAnswers,
  roundProblem,
  setAnswerText,
  toAnswers,
} from '../../lib/planner/answers';
import { QuestionCard } from './question-card';

/**
 * The current round of question cards. **Accept all recommendations** fills
 * every card; one submit sends the whole round as one turn (D7). The parent
 * keys this by the round's question ids, so a new round starts empty.
 */
export function QuestionRound({
  questions,
  disabled,
  disabledReason,
  onSubmit,
}: {
  questions: readonly PlanQuestion[];
  disabled?: boolean;
  /** Why the round cannot be sent now, beside the button. */
  disabledReason?: string;
  /** Resolves when the turn was accepted; rejects to keep the answers. */
  onSubmit: (answers: PlanAnswer[]) => Promise<void>;
}) {
  const [round, setRound] = useState<RoundAnswers>(EMPTY_ROUND);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const problem = roundProblem(round, questions);
  const off = disabled || busy;

  const submit = async () => {
    setTried(true);
    if (problem || off) return;
    setBusy(true);
    try {
      await onSubmit(toAnswers(round, questions));
      setRound(EMPTY_ROUND);
      setTried(false);
    } catch {
      // The caller said why; the answers stay for another try.
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex min-w-0 flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-ink-3" aria-live="polite">
          {answeredText(round, questions)}
        </span>
        <Button
          size="sm"
          variant="glass"
          disabled={off}
          onClick={() => setRound(acceptAllRecommendations(round, questions))}
        >
          Accept all recommendations
        </Button>
      </div>
      {questions.map((q, i) => (
        <QuestionCard
          key={q.id}
          question={q}
          index={i + 1}
          answer={round[q.id]}
          disabled={off}
          onPick={(optionId) => setRound((r) => pickOption(r, q.id, optionId))}
          onText={(text) => setRound((r) => setAnswerText(r, q.id, text))}
          onAccept={() => setRound((r) => acceptRecommendation(r, q))}
        />
      ))}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {tried && problem ? (
          <p role="alert" className="text-sm text-danger">
            {ROUND_PROBLEM_TEXT[problem]}
          </p>
        ) : disabled && disabledReason ? (
          <p className="text-sm text-ink-3">{disabledReason}</p>
        ) : null}
        <Button type="submit" disabled={off}>
          {busy ? 'Sending…' : 'Send answers'}
        </Button>
      </div>
    </form>
  );
}
