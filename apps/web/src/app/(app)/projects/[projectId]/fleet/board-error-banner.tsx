'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Disclosure } from '@andrewbehma/glass-ui/disclosure';
import { toast } from '@andrewbehma/glass-ui/toast';
import type { BoardErrorView } from '@nautelle/shared';
import { useState } from 'react';
import { boardErrorView } from '../../../../../lib/fleet/format';
import { useErrorToast } from '../../../../../lib/section/use-error-toast';

/**
 * The orchestrator's board could not be read: the page's one banner for it
 * (#213 — the Orchestrator card no longer repeats it). The detail opens in
 * place, and the file to fix can be copied.
 */
export function BoardErrorBanner({ error }: { error: BoardErrorView }) {
  const issue = boardErrorView(error);
  const [open, setOpen] = useState(false);
  const showError = useErrorToast();
  return (
    <Banner
      tone="warn"
      title={issue.title}
      action={
        <Button
          variant="glass"
          size="sm"
          onClick={() => {
            navigator.clipboard
              .writeText(issue.path)
              .then(() => toast.success('Path copied.'))
              .catch(() =>
                showError({
                  text: `Could not copy the path. It is ${issue.path}.`,
                }),
              );
          }}
        >
          Copy path
        </Button>
      }
    >
      <Disclosure
        className="mt-1 border-0 bg-transparent"
        triggerClassName="px-0 py-1"
        open={open}
        onOpenChange={setOpen}
        trigger={open ? 'Hide detail' : 'Show detail'}
      >
        <p className="mt-1 text-sm">{issue.detail}</p>
      </Disclosure>
    </Banner>
  );
}
