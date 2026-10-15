'use client';

import type { BoardView, PlanAnswer } from '@agentdock/shared';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { fetchBoard } from '../../lib/board/actions';
import { intakePhase, roundText } from '../../lib/board/intake';
import { roundKey } from '../../lib/planner/answers';
import { describePlannerError } from '../../lib/planner/format';
import { usePlan } from '../../lib/planner/use-plan';
import { useSection } from '../../lib/section/use-section';
import { FailedTurn } from '../planner/failed-turn';
import { QuestionStepper } from '../planner/question-stepper';
import { RunningTurn } from '../planner/running-turn';

/**
 * The interview of a New Card (#337 D2–D4): what the person asked, then
 * the model thinking, the open round one question at a time, or the failed
 * turn to retry. **Enough — generate** is there whenever no turn runs — with
 * a round open it answers the rest with their recommendations. Once the
 * card exists, it opens.
 */
export function IntakeView({
  projectId,
  planId,
  board,
  onOpenCard,
  onClose,
}: {
  projectId: string;
  planId: string;
  board?: BoardView;
  onOpenCard: (number: number) => void;
  onClose: () => void;
}) {
  const section = usePlan(projectId, planId);
  const { actions, busy } = section;
  const plan = section.data;
  // Off the Board (the Work list), the card is looked up once it exists.
  const done = plan?.status === 'done';
  const fetched = useSection<BoardView | undefined>(
    () =>
      done && board === undefined
        ? fetchBoard(projectId)
        : Promise.resolve(undefined),
    [projectId, done, board === undefined],
  );

  if (!plan) {
    return section.error ? (
      <Banner
        tone="danger"
        title="The draft could not be loaded"
        action={
          <Button size="sm" variant="glass" onClick={section.retry}>
            Try again
          </Button>
        }
      >
        {describePlannerError(section.error)}
      </Banner>
    ) : (
      <Skeleton className="h-48 w-full" />
    );
  }

  const phase = intakePhase(plan, board ?? fetched.data);
  const generate = (answers: PlanAnswer[]) =>
    actions.planTurn({
      ...(answers.length > 0 ? { answers } : {}),
      generate: true,
    });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-1 rounded-control bg-hover px-3 py-2">
        <span className="text-xs font-medium text-ink-3">What to do</span>
        <p className="text-sm whitespace-pre-line break-words text-ink">
          {plan.brief}
        </p>
      </div>

      {phase.kind === 'thinking' ? (
        <RunningTurn
          projectId={projectId}
          turn={phase.turn}
          canCancel
          cancelling={busy?.kind === 'cancel'}
          onCancel={() =>
            void actions.cancelTurn(phase.turn.id).catch(() => {})
          }
        />
      ) : null}

      {phase.kind === 'failed' ? (
        <FailedTurn
          turn={phase.turn}
          canRetry
          retrying={busy?.kind === 'retry'}
          onRetry={() => void actions.retryTurn(phase.turn.id).catch(() => {})}
        />
      ) : null}

      {phase.kind === 'round' ? (
        <section aria-label="Questions" className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-ink">
            {roundText(phase.round, phase.maxRounds)}
          </h3>
          <QuestionStepper
            key={roundKey(plan.questions)}
            questions={plan.questions}
            disabled={busy !== null}
            onSubmit={(answers) =>
              actions.planTurn({ answers }).then(() => undefined)
            }
            onGenerate={(answers) => generate(answers).then(() => undefined)}
          />
        </section>
      ) : null}

      {phase.kind === 'idle' || phase.kind === 'failed' ? (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <span className="text-sm text-ink-3">
            The planner writes the card from what it has.
          </span>
          <Button
            variant="glass"
            disabled={busy !== null}
            onClick={() => void generate([]).catch(() => {})}
          >
            Enough — generate
          </Button>
        </div>
      ) : null}

      {phase.kind === 'thinking' ? (
        <p className="text-sm text-ink-3">
          You can close this: the draft stays on the Board, and the questions
          wait for you there.
        </p>
      ) : null}

      {phase.kind === 'done' ? (
        <Banner
          tone="ok"
          title={
            phase.card
              ? `${phase.card.label} is in Todo`
              : 'The card is written'
          }
          action={
            phase.card ? (
              <Button
                size="sm"
                onClick={() => phase.card && onOpenCard(phase.card.number)}
              >
                Open the card
              </Button>
            ) : undefined
          }
        >
          {phase.card ? phase.card.title : 'It appears in Todo in a moment.'}
        </Banner>
      ) : null}

      {phase.kind === 'closed' ? (
        <Banner tone="info" title="This draft was discarded">
          No card was made from it.
        </Banner>
      ) : null}

      {phase.kind === 'done' || phase.kind === 'closed' ? (
        <div className="flex justify-end">
          <Button variant="glass" onClick={onClose}>
            Close
          </Button>
        </div>
      ) : null}
    </div>
  );
}
