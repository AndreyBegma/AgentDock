'use client';

import type { PlanAnswer, PlanQuestion } from '@agentdock/shared';
import { Button } from '@andrewbehma/glass-ui/button';
import { useState } from 'react';
import {
  acceptRecommendation,
  answeredText,
  EMPTY_ROUND,
  pickOption,
  ROUND_PROBLEM_TEXT,
  type RoundAnswers,
  roundProblem,
  setAnswerText,
  toAnswers,
  toggleOption,
} from '../../lib/planner/answers';
import {
  clampStep,
  dotLabel,
  generateAnswers,
  generateProblem,
  stepDots,
  stepLabel,
} from '../../lib/planner/stepper';
import { QuestionCard } from './question-card';

/**
 * #678: the Previous / Next row pinned just above the phone back bar (60 px
 * tall at its own offset), so it follows the soft keyboard with it.
 */
const THUMB_NAV =
  'glass-strong fixed inset-x-2.5 bottom-[calc(max(env(safe-area-inset-bottom),12px)+var(--keyboard-inset)+68px)] z-[calc(var(--z-index-chrome)+2)] flex-nowrap rounded-[18px] p-1.5 pr-3';
const THUMB_BUTTON = 'h-(--size-tap) px-4 text-[15px]';

/**
 * A round one question at a time (#337 D3): question *k of n* with Previous
 * / Next, a dot per question (filled once answered, ringed when current),
 * **Send answers** for the whole round, and — when `onGenerate` is given —
 * **Enough — generate**, which sends the round with every unanswered
 * question taking its recommendation. The parent keys this by the round's
 * question ids, so a new round starts empty at its first question.
 */
export function QuestionStepper({
  questions,
  disabled,
  disabledReason,
  thumbNav = false,
  onSubmit,
  onGenerate,
}: {
  questions: readonly PlanQuestion[];
  disabled?: boolean;
  /**
   * In a full-screen phone layer (#678): Previous and Next stick to the
   * bottom of the scroll area at the 44 px tap size, so stepping back
   * between questions stays in the thumb zone.
   */
  thumbNav?: boolean;
  /** Why the round cannot be sent now, beside the buttons. */
  disabledReason?: string;
  /** Resolves when the turn was accepted; rejects to keep the answers. */
  onSubmit: (answers: PlanAnswer[]) => Promise<void>;
  onGenerate?: (answers: PlanAnswer[]) => Promise<void>;
}) {
  const [round, setRound] = useState<RoundAnswers>(EMPTY_ROUND);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState<'send' | 'generate' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const off = disabled === true || busy !== null;
  const at = clampStep(step, questions.length);
  const current = questions[at];
  const dots = stepDots(questions, round, at);

  const send = async (kind: 'send' | 'generate') => {
    const sendProblem = kind === 'send' ? roundProblem(round, questions) : null;
    const why =
      sendProblem !== null
        ? ROUND_PROBLEM_TEXT[sendProblem]
        : kind === 'generate'
          ? generateProblem(round, questions)
          : null;
    if (why !== null) {
      setProblem(why);
      return;
    }
    if (off) return;
    setProblem(null);
    setBusy(kind);
    try {
      if (kind === 'send') await onSubmit(toAnswers(round, questions));
      else await onGenerate?.(generateAnswers(round, questions));
      setRound(EMPTY_ROUND);
      setStep(0);
    } catch {
      // The caller said why; the answers stay for another try.
    } finally {
      setBusy(null);
    }
  };

  if (!current) return null;

  return (
    <form
      className={`flex min-w-0 flex-col gap-3${thumbNav ? ' pb-16' : ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        void send('send');
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-ink" aria-live="polite">
          {stepLabel(at, questions.length)}
        </span>
        <ol className="flex items-center gap-1.5" aria-label="Questions">
          {dots.map((dot) => (
            <li key={dot.questionId}>
              <button
                type="button"
                aria-label={dotLabel(dot)}
                aria-current={dot.current ? 'step' : undefined}
                onClick={() => setStep(dot.index)}
                className={`block size-2.5 rounded-full transition-colors ${
                  dot.answered ? 'bg-accent' : 'bg-line'
                } ${dot.current ? 'ring-2 ring-accent/50 ring-offset-1 ring-offset-content' : ''}`}
              />
            </li>
          ))}
        </ol>
      </div>

      <QuestionCard
        key={current.id}
        question={current}
        index={at + 1}
        answer={round[current.id]}
        disabled={off}
        onPick={(optionId) =>
          setRound((r) => pickOption(r, current.id, optionId))
        }
        onToggle={(optionId, checked) =>
          setRound((r) => toggleOption(r, current, optionId, checked))
        }
        onText={(text) => setRound((r) => setAnswerText(r, current.id, text))}
        onAccept={() => setRound((r) => acceptRecommendation(r, current))}
      />

      <div
        data-thumb-nav={thumbNav ? '' : undefined}
        className={`flex flex-wrap items-center justify-between gap-2${
          thumbNav ? ` ${THUMB_NAV}` : ''
        }`}
      >
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="glass"
            disabled={at === 0}
            onClick={() => setStep(at - 1)}
            className={thumbNav ? THUMB_BUTTON : undefined}
          >
            Previous
          </Button>
          <Button
            size="sm"
            variant="glass"
            disabled={at >= questions.length - 1}
            onClick={() => setStep(at + 1)}
            className={thumbNav ? THUMB_BUTTON : undefined}
          >
            Next
          </Button>
        </div>
        <span className="text-xs text-ink-3">
          {answeredText(round, questions)}
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-3">
        {problem ? (
          <p role="alert" className="text-sm text-danger">
            {problem}
          </p>
        ) : disabled && disabledReason ? (
          <p className="text-sm text-ink-3">{disabledReason}</p>
        ) : null}
        {onGenerate ? (
          <Button
            variant="glass"
            disabled={off}
            onClick={() => void send('generate')}
          >
            {busy === 'generate' ? 'Generating…' : 'Enough — generate'}
          </Button>
        ) : null}
        <Button type="submit" disabled={off}>
          {busy === 'send' ? 'Sending…' : 'Send answers'}
        </Button>
      </div>
    </form>
  );
}
