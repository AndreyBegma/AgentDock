'use client';

import type { PlanTurnView } from '@agentdock/shared';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { Disclosure } from '@andrewbehma/glass-ui/disclosure';
import Link from 'next/link';
import { useState } from 'react';
import { isContractViolation } from '../../lib/planner/format';
import { failedTurnCopy } from '../../lib/planner/runner-support';

/**
 * A failed turn: the error and **Retry turn**. For a `contract_violation`
 * (D17) the planner's raw answer was kept, and sits in a `Disclosure` so the
 * person can see what it said instead of what the contract asked for.
 */
export function FailedTurn({
  turn,
  canRetry,
  retrying,
  onRetry,
}: {
  turn: PlanTurnView;
  canRetry: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const violation = isContractViolation(turn);
  const copy = failedTurnCopy(turn);
  return (
    <Banner
      tone="danger"
      title={copy.title}
      action={
        canRetry ? (
          <Button
            size="sm"
            variant="glass"
            disabled={retrying}
            onClick={onRetry}
          >
            {retrying ? 'Retrying…' : 'Retry turn'}
          </Button>
        ) : undefined
      }
    >
      <div className="flex min-w-0 flex-col gap-2">
        <p className="break-words">{copy.text}</p>
        {copy.updateHref ? (
          <Link
            href={copy.updateHref}
            className={`${buttonClassName({ variant: 'glass', size: 'sm' })} self-start`}
          >
            Update the runner
          </Link>
        ) : null}
        {violation && turn.resultText ? (
          <Disclosure
            open={open}
            onOpenChange={setOpen}
            trigger={open ? 'Hide the raw output' : 'Show the raw output'}
            triggerClassName="text-sm text-accent-ink underline underline-offset-2"
          >
            <pre className="mt-2 max-h-80 overflow-auto rounded-control bg-hover p-3 font-mono text-xs whitespace-pre-wrap break-words text-ink-2">
              {turn.resultText}
            </pre>
          </Disclosure>
        ) : null}
      </div>
    </Banner>
  );
}
