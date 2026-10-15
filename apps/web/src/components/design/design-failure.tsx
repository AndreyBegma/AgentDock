'use client';

import type { DesignFailureView } from '@agentdock/shared';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { failureSentence } from '../../lib/design/progress';

/**
 * How the last batch ended without a revision (#275 D6): the reason and, for
 * an operator, **Retry** — Generate or Revise in the failed batch's mode. A
 * stop is the person's own doing, so it reads as information, not an alarm.
 */
export function DesignFailure({
  failure,
  canRetry,
  retrying,
  onRetry,
}: {
  failure: DesignFailureView;
  canRetry: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <Banner
      tone={failure.reason === 'stopped' ? 'info' : 'danger'}
      action={
        canRetry ? (
          <Button
            size="sm"
            variant="glass"
            disabled={retrying}
            onClick={onRetry}
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </Button>
        ) : null
      }
    >
      {failureSentence(failure)}
    </Banner>
  );
}
