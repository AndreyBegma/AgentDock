'use client';

import { buttonClassName } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { Progress } from '@andrewbehma/glass-ui/progress';
import { Check, Circle } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { RunnersFact } from '../../lib/prerequisites/facts';
import {
  InstallCommands,
  InstallGuideLink,
  KeepOnlineCommands,
} from './runner-commands';
import { currentStep, type GettingStarted as State, type Step } from './steps';

/** What to do for the step the checklist is on. */
function StepBody({ step, runners }: { step: Step; runners: RunnersFact }) {
  switch (step.id) {
    case 'install':
      return (
        <>
          <p>
            The runner is the AgentDock daemon. It runs agents and reads the
            repositories on its machine. Install it with one of:
          </p>
          <InstallCommands />
          <InstallGuideLink />
        </>
      );
    case 'pair':
      return (
        <p>
          Add a runner on the Runners page and run the pairing command it shows
          on that machine. The code works once and expires after 10 minutes.
        </p>
      );
    case 'online': {
      const idle = runners.kind === 'offline' ? runners.runners : [];
      return (
        <>
          <p>
            {idle.length > 0
              ? `${idle.map((runner) => runner.name).join(', ')} ${idle.length === 1 ? 'is' : 'are'} paired but not running. Start it on that machine:`
              : 'Start the runner on its machine:'}
          </p>
          <KeepOnlineCommands />
          <InstallGuideLink />
        </>
      );
    }
    case 'project':
      return (
        <p>
          Pick the runner and the absolute path of a GitHub repository&apos;s
          clone on its machine. AgentDock inspects it before anything is stored.
        </p>
      );
    default:
      return null;
  }
}

function StepRow({
  step,
  number,
  open,
  children,
}: {
  step: Step;
  number?: number;
  open: boolean;
  children?: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 shrink-0" aria-hidden="true">
        {step.done ? (
          <Check className="size-4 text-ok" />
        ) : (
          <Circle className="size-4 text-ink-3" />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span
            className={
              step.done
                ? 'text-sm text-ink-3 line-through'
                : open
                  ? 'text-sm font-medium'
                  : 'text-sm'
            }
          >
            {number ? `${number}. ` : ''}
            {step.title}
            <span className="sr-only">
              {step.done ? ' — done' : ' — to do'}
            </span>
          </span>
          {!step.done && step.href && step.cta ? (
            <Link
              href={step.href}
              className={buttonClassName({
                variant: open ? 'solid' : 'glass',
                size: 'sm',
              })}
            >
              {step.cta}
            </Link>
          ) : null}
        </div>
        {open && children ? (
          <div className="flex flex-col gap-2 text-sm text-ink-2">
            {children}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Getting started (issue #132): the first-run steps for an admin, with the
 * commands for the step they are on. The caller hides it once `complete`.
 */
export function GettingStarted({
  state,
  runners,
}: {
  state: State;
  runners: RunnersFact;
}) {
  const current = currentStep(state);
  const required = state.steps.filter((step) => !step.optional);
  const optional = state.steps.filter((step) => step.optional);

  return (
    <Card pad="lg" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-bold">Getting started</h2>
        <p className="text-sm text-ink-2">
          AgentDock drives agents on your own machines. These steps get the
          first project running.
        </p>
      </div>
      <Progress
        value={state.done}
        max={state.total}
        label={`${state.done} of ${state.total}`}
        tone={state.complete ? 'ok' : 'neutral'}
      />
      <ol className="flex flex-col gap-4">
        {required.map((step, index) => (
          <StepRow
            key={step.id}
            step={step}
            number={index + 1}
            open={step.id === current?.id}
          >
            <StepBody step={step} runners={runners} />
          </StepRow>
        ))}
      </ol>
      <div className="flex flex-col gap-3 border-t border-line pt-4">
        <h3 className="text-sm font-semibold">Optional</h3>
        <ul className="flex flex-col gap-3">
          {optional.map((step) => (
            <StepRow key={step.id} step={step} open={false} />
          ))}
        </ul>
      </div>
    </Card>
  );
}
