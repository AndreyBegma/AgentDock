'use client';

import type { PlanQuestion } from '@agentdock/shared';
import { Badge } from '@andrewbehma/glass-ui/badge';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { Checkbox } from '@andrewbehma/glass-ui/checkbox';
import { Field, Textarea } from '@andrewbehma/glass-ui/field';
import { Radio, RadioGroup } from '@andrewbehma/glass-ui/radio-group';
import { Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { type CardAnswer, isRecommended } from '../../lib/planner/answers';

/**
 * One question of a round (D7): its number, title and question, the options
 * as native radios (arrow keys move between them) — or checkboxes for a
 * `multiple` question (#337 D3) — the planner's recommendation with its one
 * line of why, and **Write your own**, offered on every question. Every
 * control is a native input, so the card is keyboard operable as it stands.
 */
export function QuestionCard({
  question,
  index,
  answer,
  disabled,
  onPick,
  onToggle,
  onText,
  onAccept,
}: {
  question: PlanQuestion;
  /** 1-based, as the planner numbers its questions. */
  index: number;
  answer: CardAnswer | undefined;
  disabled?: boolean;
  onPick: (optionId: string) => void;
  /** #337 D3: checks or unchecks an option of a `multiple` question. */
  onToggle: (optionId: string, checked: boolean) => void;
  onText: (text: string) => void;
  onAccept: () => void;
}) {
  const rec = question.recommendation;
  const accepted = isRecommended(answer, question);
  const base = `q-${question.id}`;

  return (
    <Card
      variant="content"
      pad="md"
      className="flex min-w-0 flex-col gap-3"
      aria-labelledby={`${base}-title`}
      role="group"
    >
      <QuestionHead
        question={question}
        index={index}
        titleId={`${base}-title`}
      />

      <Recommendation question={question}>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || accepted}
          onClick={onAccept}
          aria-label={`Accept the recommendation for question ${index}`}
        >
          {accepted ? 'Accepted' : 'Accept'}
        </Button>
      </Recommendation>

      {question.options.length > 0 && question.multiple === true ? (
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-1 text-xs font-medium text-ink-3">
            Pick any that apply
          </legend>
          {question.options.map((option) => (
            <Checkbox
              key={option.id}
              id={`${base}-${option.id}`}
              label={
                option.id === rec.optionId
                  ? `${option.label} (recommended)`
                  : option.label
              }
              hint={option.detail}
              checked={answer?.optionIds?.includes(option.id) ?? false}
              disabled={disabled}
              onChange={(e) => onToggle(option.id, e.target.checked)}
            />
          ))}
        </fieldset>
      ) : question.options.length > 0 ? (
        <RadioGroup label={question.title} className="flex flex-col gap-2">
          {question.options.map((option) => (
            <Radio
              key={option.id}
              name={base}
              value={option.id}
              label={
                option.id === rec.optionId
                  ? `${option.label} (recommended)`
                  : option.label
              }
              hint={option.detail}
              checked={answer?.optionId === option.id}
              disabled={disabled}
              onChange={() => onPick(option.id)}
            />
          ))}
        </RadioGroup>
      ) : null}

      <Field
        label={question.options.length > 0 ? 'Write your own' : 'Your answer'}
        htmlFor={`${base}-text`}
        hint={
          question.options.length > 0
            ? question.multiple === true
              ? 'Sent with the options you checked, or on its own.'
              : 'Sent with the option, if one is picked.'
            : undefined
        }
      >
        <Textarea
          id={`${base}-text`}
          rows={2}
          value={answer?.text ?? ''}
          disabled={disabled}
          onChange={(e) => onText(e.target.value)}
        />
      </Field>
    </Card>
  );
}

/**
 * A question of an earlier round, read-only (#184): what was asked, what
 * the planner recommended, and the answer given — or that none was.
 */
export function AnsweredQuestionCard({
  question,
  index,
  idPrefix,
  answer,
  recommended,
  answered,
}: {
  question: PlanQuestion;
  index: number;
  /** Keeps ids unique when several rounds ask a question with the same id. */
  idPrefix: string;
  /** The answer in words, or null when the question got none. */
  answer: string | null;
  /** The answer is the planner's recommendation. */
  recommended: boolean;
  /** Whether the round was answered at all, or a later round replaced it. */
  answered: boolean;
}) {
  const rec = question.recommendation;
  const recOption = question.options.find((o) => o.id === rec.optionId);
  const titleId = `${idPrefix}-q-${question.id}-title`;

  return (
    <Card
      variant="content"
      pad="md"
      className="flex min-w-0 flex-col gap-3"
      aria-labelledby={titleId}
      role="group"
    >
      <QuestionHead question={question} index={index} titleId={titleId} />
      <Recommendation question={question} />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-xs font-medium text-ink-3">Answer</span>
        {answer !== null ? (
          <p className="inline-flex flex-wrap items-center gap-2 text-sm break-words text-ink">
            {answer}
            {recommended ? <Badge tone="ok" label="Recommendation" /> : null}
          </p>
        ) : answered && !question.blocking ? (
          <p className="text-sm text-ink-2">
            Left to the default: {recOption?.label ?? rec.text}
          </p>
        ) : (
          <p className="text-sm text-ink-3">Not answered</p>
        )}
      </div>
    </Card>
  );
}

function QuestionHead({
  question,
  index,
  titleId,
}: {
  question: PlanQuestion;
  index: number;
  titleId: string;
}) {
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h4 id={titleId} className="min-w-0 text-sm font-semibold text-ink">
          <span className="text-ink-3 tabular-nums">{index}.</span>{' '}
          {question.title}
        </h4>
        {question.blocking ? (
          <Badge tone="danger" label="Blocking" />
        ) : (
          <Badge tone="neutral" label="Has a default" />
        )}
      </div>
      <p className="text-sm whitespace-pre-line text-ink-2">
        {question.question}
      </p>
    </>
  );
}

/** The planner's recommendation with its one line of why; `children` acts on it. */
function Recommendation({
  question,
  children,
}: {
  question: PlanQuestion;
  children?: ReactNode;
}) {
  const rec = question.recommendation;
  const recOption = question.options.find((o) => o.id === rec.optionId);
  return (
    <div className="flex flex-col gap-1 rounded-control bg-hover px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-accent-ink">
          <Sparkles aria-hidden="true" className="size-3.5" />
          Recommended: {recOption?.label ?? rec.text}
        </span>
        {children}
      </div>
      <p className="text-xs text-ink-2">{rec.why}</p>
    </div>
  );
}
